import { publicLabel } from './presentation.js';

export function validateDataset(dataset) {
  const { nodes, edges } = dataset.canonical ?? {};
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error('Canonical nodes and edges are missing.');
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length) throw new Error('Duplicate canonical node IDs.');
  if (nodes.some(node => typeof node.id !== 'string' || !node.id || typeof node.label !== 'string')) throw new Error('Invalid canonical node.');
  const edgeKeys = edges.map(edge => edgeKey(edge.source, edge.target));
  if (new Set(edgeKeys).size !== edges.length) throw new Error('Duplicate canonical directed edges.');
  if (edges.some(edge => !ids.has(edge.source) || !ids.has(edge.target))) throw new Error('Invalid edge endpoint.');
  if (nodes.length !== dataset.quality_assurance.canonical_node_count || edges.length !== dataset.quality_assurance.canonical_directed_edge_count) throw new Error('Canonical counts disagree with dataset QA.');
  const edgeSet = new Set(edgeKeys);
  for (const split of dataset.structural_annotations.splits) {
    if (split.first_targets_of_documented_branches.some(target => !edgeSet.has(edgeKey(split.at_node, target)))) throw new Error(`Invalid split ${split.marker}.`);
  }
  const markers = dataset.structural_annotations.rejoins.map(rejoin => rejoin.source_marker);
  if (new Set(markers).size !== markers.length || dataset.structural_annotations.rejoins.some(rejoin => !ids.has(rejoin.at_node))) throw new Error('Invalid rejoin annotations.');
  for (const loop of feedbackSequences(dataset)) {
    const path = loop.closed_node_sequence;
    if (path[0] !== path.at(-1) || path.slice(1).some((target, i) => !edgeSet.has(edgeKey(path[i], target)))) throw new Error(`Invalid feedback sequence ${loop.id}.`);
  }
  return dataset;
}

export const edgeKey = (source, target) => `${source}|${target}`;
export const feedbackSequences = dataset => dataset.structural_annotations.feedback_loops.flatMap(loop => loop.variants ? loop.variants.map(variant => ({ ...variant, system: loop.id })) : [loop]);

export function createModel(dataset) {
  validateDataset(dataset);
  const nodes = new Map(dataset.canonical.nodes.map(node => [node.id, node]));
  const outgoing = new Map([...nodes.keys()].map(id => [id, []]));
  const incoming = new Map([...nodes.keys()].map(id => [id, []]));
  for (const edge of dataset.canonical.edges) {
    outgoing.get(edge.source).push(edge.target);
    incoming.get(edge.target).push(edge.source);
  }
  return { dataset, nodes, outgoing, incoming };
}

export function searchNodes(model, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const score = node => node.id.toLowerCase() === needle ? 0 : node.id.toLowerCase().startsWith(needle) ? 1 : 2;
  return [...model.nodes.values()].filter(node => node.id.toLowerCase().includes(needle) || node.label.toLocaleLowerCase().includes(needle) || publicLabel(node).toLocaleLowerCase().includes(needle)).sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

// BFS returns one shortest canonical route. Edge count carries no economic weight.
export function pathToLand(model, start) {
  if (!model.nodes.has(start)) return null;
  const queue = [start], parents = new Map([[start, null]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current === 'L1') {
      const path = [];
      for (let id = current; id !== null; id = parents.get(id)) path.push(id);
      return path.reverse();
    }
    for (const target of model.outgoing.get(current)) if (!parents.has(target)) {
      parents.set(target, current);
      queue.push(target);
    }
  }
  return null;
}

export function pathEdges(path) {
  return path.slice(1).map((target, index) => edgeKey(path[index], target));
}

// Follow every canonical alternative, visiting cycles once and stopping at L1.
export function downstreamToLand(model, start) {
  if (!model.nodes.has(start)) return { nodeIds: [], edgeIds: [] };
  const visited = new Set([start]), queue = [start], edges = new Set();
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    if (source === 'L1') continue;
    for (const target of model.outgoing.get(source)) {
      edges.add(edgeKey(source, target));
      if (!visited.has(target)) { visited.add(target); queue.push(target); }
    }
  }
  return { nodeIds: [...visited], edgeIds: [...edges] };
}

// Trace an issue up to other issues, then retain independent return paths.
// The completed forward trace is a fixed exclusion set, so branch order cannot
// change which returns qualify. UI-only incoming-neighbour highlights are not blockers.
export function problemSelection(model, start) {
  if (!model.nodes.has(start)) return { nodeIds: [], edgeIds: [], backwardNodeIds: [], backwardEdgeIds: [] };
  const primary = new Set([start]), edges = new Set(), boundaries = new Set(), queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const source = queue[i];
    if (source === 'L1') continue;
    for (const target of model.outgoing.get(source)) {
      edges.add(edgeKey(source, target));
      const seen = primary.has(target);
      primary.add(target);
      if (/^P[1-6]$/.test(target) && target !== start) boundaries.add(target);
      else if (!seen) queue.push(target);
    }
  }
  const nodes = new Set(primary), backwardNodes = new Set(), backwardEdges = new Set();
  for (const boundary of boundaries) {
    const allowed = id => id !== 'L1' && (id === start || id === boundary || !primary.has(id));
    // Prune branches that cannot lead back to this boundary in the reverse search.
    const reachable = new Set([boundary]), candidates = [boundary];
    for (let i = 0; i < candidates.length; i++) {
      const source = candidates[i];
      if (source === start) continue;
      for (const target of model.outgoing.get(source)) if (allowed(target) && !reachable.has(target)) {
        reachable.add(target); candidates.push(target);
      }
    }
    if (!reachable.has(start)) continue;
    const path = [start], onPath = new Set(path);
    function backwards(current) {
      if (current === boundary) {
        for (let i = 1; i < path.length; i++) {
          const edge = edgeKey(path[i], path[i - 1]);
          nodes.add(path[i]); edges.add(edge); backwardEdges.add(edge);
          if (!primary.has(path[i])) backwardNodes.add(path[i]);
        }
        return;
      }
      for (const previous of model.incoming.get(current)) {
        if (!allowed(previous) || !reachable.has(previous) || onPath.has(previous)) continue;
        path.push(previous); onPath.add(previous);
        backwards(previous);
        onPath.delete(previous); path.pop();
      }
    }
    backwards(start);
  }
  return { nodeIds: [...nodes], edgeIds: [...edges], backwardNodeIds: [...backwardNodes], backwardEdgeIds: [...backwardEdges] };
}

// Complete documented loops containing the selected node or the reached land
// boundary. Newly added members do not trigger expansion of overlapping loops.
export function withFeedbackLoops(dataset, selection, { completeAtLand = false, selectedNode = null } = {}) {
  const nodes = new Set(selection.nodeIds), edges = new Set(selection.edgeIds);
  const loops = feedbackSequences(dataset);
  const completeLand = completeAtLand && nodes.has('L1');
  const root = nodes.has(selectedNode) ? selectedNode : null;
  for (const loop of loops.filter(loop => loop.closed_node_sequence.includes(root) || (completeLand && loop.closed_node_sequence.includes('L1')))) {
    for (const id of loop.closed_node_sequence) nodes.add(id);
    for (const id of pathEdges(loop.closed_node_sequence)) edges.add(id);
  }
  const complete = loops.filter(loop => loop.closed_node_sequence.every(id => nodes.has(id)) && pathEdges(loop.closed_node_sequence).every(id => edges.has(id)));
  return {
    ...selection, nodeIds: [...nodes], edgeIds: [...edges],
    feedbackLoopIds: complete.map(loop => loop.id),
    feedbackNodeIds: [...new Set(complete.flatMap(loop => loop.closed_node_sequence))],
    feedbackEdgeIds: [...new Set(complete.flatMap(loop => pathEdges(loop.closed_node_sequence)))]
  };
}

export function toElements(dataset) {
  return [
    ...dataset.canonical.nodes.map(node => ({ group: 'nodes', data: { ...node, role: node.id === 'L1' ? 'land' : /^P[1-6]$/.test(node.id) ? 'problem' : 'mechanism' } })),
    ...dataset.canonical.edges.map(edge => ({ group: 'edges', data: { ...edge, id: edgeKey(edge.source, edge.target) } }))
  ];
}
