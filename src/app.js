import { createModel, searchNodes, toElements, pathToLand, pathEdges, problemSelection, withFeedbackLoops, feedbackSequences, edgeKey } from './model.js';
import { publicLabel, publicLoopLabel, publicEdgeQualification } from './presentation.js';
import { applyEdgeRoute, createLayoutEditor } from './layout-editor.js';
import { createNodeLabels } from './node-labels.js';

export let graph;
let model, layout, layoutEditor, selectedId = null, fullLabels = false;
let infoOpenBeforeSelection = null;
let reversedArrows = false, selectionView = null;
const $ = id => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const mutedOpacity = .13;
const extendedOpacity = (1 + mutedOpacity) / 2;
const feedbackColour = '#b36b1c';
const wheelSensitivity = 1.1;
// Cytoscape normalises a mousewheel notch to a zoom exponent of 3 / 250.
// Keep regular labels seven notches farther out from their original threshold.
const readingZoom = .55 * 10 ** (-7 * 3 / 250 * wheelSensitivity);
const overviewZoom = .28;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function announce(message) { $('announcement').textContent = message; }
function displayedConnection({ source, target }) {
  return reversedArrows ? { from: target, to: source } : { from: source, to: target };
}
function connectionLabel(edge) {
  const { from, to } = displayedConnection(edge);
  return `${from} → ${to}`;
}
function arrowMeaning() { return reversedArrows ? 'contributes to or worsens' : 'is caused or worsened by'; }
function plain(text = '') {
  return text.replace(/\*\*/g, '').replace(/`/g, '')
    .replace(/\bPerceived problem(s?)\b/g, (_, plural) => `Current issue${plural}`)
    .replace(/\bperceived problem(s?)\b/g, (_, plural) => `current issue${plural}`)
    .replace(/; completed in v10\b/g, '');
}
function paragraph(text, className) { return element('p', className, text); }
function section(title, subtext) {
  const box = element('section', 'detail-section');
  box.append(element('h3', '', title));
  if (subtext) box.append(paragraph(subtext, 'subtext'));
  return box;
}
function button(text, className, action) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function relationButton(id, tone = 'outgoing') {
  const node = model.nodes.get(id);
  const result = button('', `relation-button ${tone}`, () => selectNode(id, true));
  result.append(element('span', 'node-badge', id), element('span', '', publicLabel(node)));
  result.setAttribute('aria-label', `Select ${id}: ${publicLabel(node)}`);
  return result;
}
function detailHeader(kicker, labelClass = 'eyebrow') {
  const row = element('div', labelClass === 'eyebrow' ? 'detail-kicker' : 'detail-kicker compact-detail-header');
  row.append(element('span', labelClass, kicker), button('Clear selection', 'text-button', () => clearSelection()));
  return row;
}
function setDetails(...nodes) {
  if (infoOpenBeforeSelection === null) infoOpenBeforeSelection = !$('info-content').hidden;
  $('details-content').replaceChildren(...nodes);
  $('selection-tab').hidden = false;
  selectInfoTab('selection');
  $('info-content').scrollTop = 0;
}

function setInfoOpen(open) {
  $('info-content').hidden = !open;
  document.querySelector('.info-box').classList.toggle('is-collapsed', !open);
  $('info-toggle').setAttribute('aria-expanded', String(open));
  $('info-toggle').setAttribute('aria-label', open ? 'Collapse information' : 'Expand information');
  $('info-toggle').textContent = open ? '\u2212' : '+';
}
function selectInfoTab(topic) {
  for (const name of ['how', 'about', 'selection']) {
    const active = name === topic;
    $(name + '-tab').setAttribute('aria-selected', String(active));
    $(name + '-tab').tabIndex = active ? 0 : -1;
    $(name + '-panel').hidden = !active;
  }
  setInfoOpen(true);
}
function showOverview() {
  $('selection-tab').hidden = true;
  $('details-content').replaceChildren();
  selectInfoTab('how');
}

// Correct the MIME type even with an older local preview server.
async function loadLogo() {
  const logo = document.querySelector('.brand img');
  try {
    const response = await fetch(logo.getAttribute('src'));
    if (!response.ok) throw new Error('Logo could not be loaded.');
    const url = URL.createObjectURL(new Blob([await response.text()], { type: 'image/svg+xml' }));
    logo.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    logo.src = url;
    await logo.decode();
  } catch (error) {
    console.error(error);
  }
}

function updateNavigation() {
  document.querySelectorAll('[data-problem]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.problem === selectedId)));
}
function removeHighlight() {
  graph.elements().removeClass('muted highlighted selected path-edge incoming downstream core-problem extended feedback-loop feedback-tint');
  graph.elements(':selected').unselect();
  $('feedback-key').hidden = true;
}
function highlight(nodeIds, edgeIds, mode) {
  $('map-hint').textContent = 'Follow the highlighted connections · Select another factor to explore';
  graph.batch(() => {
    removeHighlight();
    graph.elements().addClass('muted');
    for (const id of nodeIds) graph.getElementById(id).removeClass('muted').addClass('highlighted');
    for (const id of edgeIds) graph.getElementById(id).removeClass('muted').addClass(mode === 'path' ? 'path-edge' : 'highlighted');
  });
}
function highlightFeedbackLoops({ completeAtLand = false, selectedNode = null } = {}) {
  const selection = withFeedbackLoops(model.dataset, {
    nodeIds: graph.nodes().not('.muted').map(node => node.id()),
    edgeIds: graph.edges().not('.muted').map(edge => edge.id())
  }, { completeAtLand, selectedNode });
  graph.batch(() => {
    for (const id of [...selection.nodeIds, ...selection.edgeIds]) {
      const item = graph.getElementById(id);
      if (item.hasClass('muted')) item.removeClass('muted').addClass('extended');
    }
    for (const id of [...selection.feedbackNodeIds, ...selection.feedbackEdgeIds]) graph.getElementById(id).addClass('feedback-loop');
    graph.nodes('.feedback-loop').filter(node => !node.hasClass('selected') && !(selectedNode && node.hasClass('highlighted'))).addClass('feedback-tint');
  });
  $('feedback-key').hidden = selection.feedbackLoopIds.length === 0;
}
function focusArea() {
  const canvas = $('cy').getBoundingClientRect(), heading = document.querySelector('.map-heading').getBoundingClientRect();
  const padding = 20;
  const area = { x1: padding, y1: heading.bottom - canvas.top + 16, x2: canvas.width - padding, y2: canvas.height - 56 };
  const info = document.querySelector('.info-box');
  if (info.getClientRects().length) {
    const box = info.getBoundingClientRect();
    if (box.left - canvas.left - padding >= 320) area.x2 = box.left - canvas.left - padding;
    else area.y2 = Math.max(area.y1 + 100, box.top - canvas.top - padding);
  }
  return area;
}
function focusNode(id, wholePath = false) {
  const area = focusArea();
  // Distant connected factors stay highlighted, but do not pull local navigation away from the chosen node.
  const nodes = wholePath ? graph.nodes('.highlighted') : graph.getElementById(id);
  const bounds = nodes.boundingBox({ includeLabels: false, includeOverlays: false, includeUnderlays: false });
  const zoom = Math.max(graph.minZoom(), Math.min(.9, (area.x2 - area.x1) / bounds.w, (area.y2 - area.y1) / bounds.h));
  const centre = { x: (bounds.x1 + bounds.x2) / 2, y: (bounds.y1 + bounds.y2) / 2 };
  graph.stop(true, false);
  graph.animate({ zoom, pan: { x: (area.x1 + area.x2) / 2 - centre.x * zoom, y: (area.y1 + area.y2) / 2 - centre.y * zoom } }, { duration: reduceMotion ? 0 : 250 });
}
function selectNode(id, focus = false) {
  if (layoutEditor?.active) { layoutEditor.selectNode(id, focus); return; }
  const node = model.nodes.get(id);
  if (!node) return;
  selectionView = { kind: 'node', id };
  selectedId = id;
  $('feedback').value = '';
  const causes = model.outgoing.get(id), effects = model.incoming.get(id);
  const outgoing = reversedArrows ? effects : causes, incoming = reversedArrows ? causes : effects;
  highlight([id, ...causes, ...effects], [...causes.map(target => edgeKey(id, target)), ...effects.map(source => edgeKey(source, id))]);
  graph.batch(() => {
    for (const target of outgoing) {
      if (target !== id && target !== 'L1') graph.getElementById(target).addClass('downstream');
    }
    for (const source of incoming) {
      graph.getElementById(source).addClass('core-problem');
      graph.getElementById(reversedArrows ? edgeKey(id, source) : edgeKey(source, id)).addClass('incoming');
      // A shared neighbour can participate in both directions. Keep its node
      // green for the outgoing role; each arrow retains its own direction colour.
      if (source !== id && !outgoing.includes(source)) graph.getElementById(source).addClass('incoming');
    }
  });
  graph.getElementById(id).addClass('selected');
  if (node.id.startsWith('P')) {
    const downstream = problemSelection(model, id);
    const backwardNodes = new Set(downstream.backwardNodeIds);
    const backwardEdges = new Set(downstream.backwardEdgeIds);
    graph.batch(() => {
      for (const target of downstream.nodeIds) {
        const item = graph.getElementById(target);
        if (!item.hasClass('highlighted')) item.removeClass('muted').addClass(backwardNodes.has(target) ? 'extended incoming' : 'extended downstream');
      }
      for (const edgeId of downstream.edgeIds) {
        const edge = graph.getElementById(edgeId);
        if (!edge.hasClass('highlighted')) edge.removeClass('muted').addClass(backwardEdges.has(edgeId) ? 'extended incoming' : 'extended');
      }
    });
  }
  highlightFeedbackLoops({ completeAtLand: node.id.startsWith('P') || id === 'L1', selectedNode: id });
  $('view-label').textContent = `${id} · Direct connections`;
  updateNavigation();
  const details = [detailHeader(id, 'detail-id land'), element('h2', '', publicLabel(node))];
  const explanation = model.dataset.presentation.node_descriptions[id];
  details.push(paragraph(plain(explanation)));
  const pathButton = button(reversedArrows ? 'Show one path from L1 →' : 'Show one path to L1 →', 'primary-button', () => showPath(id));
  if (id === 'L1') details.push(button('Explore the F1 feedback loop →', 'primary-button', () => showFeedback('F1')));
  else details.push(pathButton);
  if (outgoing.length) {
    const following = section(reversedArrows ? 'Contributes to or worsens' : 'Is caused or worsened by', reversedArrows ? `${outgoing.length} direct ${outgoing.length === 1 ? 'effect' : 'effects'} · following the arrows` : `${outgoing.length} direct ${outgoing.length === 1 ? 'explanation' : 'explanations'} · following the arrows`);
    following.append(...outgoing.map(id => relationButton(id))); details.push(following);
  }
  if (incoming.length) {
    const preceding = section(reversedArrows ? 'Is caused or worsened by' : 'Contributes to or worsens', `${incoming.length} incoming ${incoming.length === 1 ? 'connection' : 'connections'}`);
    preceding.classList.add('incoming-relations');
    preceding.append(...incoming.map(id => relationButton(id, 'incoming'))); details.push(preceding);
  }
  const loops = feedbackSequences(model.dataset).filter(loop => loop.closed_node_sequence.includes(id));
  if (loops.length) {
    const feedback = section('Related feedback loops');
    for (const loop of loops) feedback.append(button(`${loop.id} · ${publicLoopLabel(loop)}`, 'secondary-button', () => showFeedback(loop.id)));
    details.push(feedback);
  }
  setDetails(...details);
  announce(`${id}: ${publicLabel(node).replace(/\.$/, '')}. ${causes.length} direct explanations and ${effects.length} direct effects.`);
  if (focus) focusNode(id);
}

function showEdge(edge) {
  selectionView = { kind: 'edge', id: edge.id() };
  selectedId = null; updateNavigation(); $('feedback').value = '';
  const { source, target, id } = edge.data();
  const { from, to } = displayedConnection(edge.data());
  highlight([source, target], [id]); edge.addClass('selected');
  graph.getElementById(from).addClass('core-problem');
  if (to !== from && to !== 'L1') graph.getElementById(to).addClass('downstream');
  $('view-label').textContent = connectionLabel(edge.data());
  const title = element('h2', 'edge-title');
  title.append(element('span', '', publicLabel(model.nodes.get(from))), element('span', 'edge-separator', `↓ ${arrowMeaning()}`), element('span', '', publicLabel(model.nodes.get(to))));
  const content = [detailHeader('SELECTED CONNECTION'), element('div', 'detail-id', connectionLabel(edge.data())), title];
  const qualification = publicEdgeQualification(id, model.dataset.interpretation.edge_qualifications[id]);
  if (qualification) {
    const box = section('Explanation and conditions'); box.append(paragraph(qualification)); content.push(box);
  }
  const nodes = section('Explore these factors'); nodes.append(relationButton(from), relationButton(to)); content.push(nodes);
  setDetails(...content);
  announce(`${from} ${arrowMeaning()} ${to}.`);
}

function pathList(path) {
  const list = element('div', 'path-list');
  path.forEach((id, i) => {
    if (i) list.append(element('div', 'path-arrow', '↓'));
    list.append(relationButton(id));
  });
  return list;
}
function showPath(id, focus = true) {
  const path = pathToLand(model, id);
  if (!path) return;
  selectionView = { kind: 'path', id };
  const displayedPath = reversedArrows ? [...path].reverse() : path;
  highlight(path, pathEdges(path), 'path');
  graph.getElementById(id).addClass('selected');
  $('view-label').textContent = `${displayedPath[0]} → ${displayedPath.at(-1)} · One illustrative path`;
  const note = element('div', 'note', 'This is one illustrative pathway. Other contributing factors and routes are also present. A shorter path does not mean a stronger influence.');
  setDetails(detailHeader('ILLUSTRATIVE PATH'), element('h2', '', reversedArrows ? `Land Value Inflation to ${id}` : `${id} to Land Value Inflation`), paragraph(`Follow each arrow as “${arrowMeaning()}”.`), note, pathList(displayedPath), button('Back to direct connections', 'secondary-button', () => selectNode(id)));
  announce(`One illustrative path: ${displayedPath.join(' to ')}. Other routes exist.`);
  if (focus) focusNode(id, true);
}
function showFeedback(id) {
  const loop = feedbackSequences(model.dataset).find(item => item.id === id);
  if (!loop) return;
  selectionView = { kind: 'feedback', id };
  selectedId = null; updateNavigation(); $('feedback').value = id;
  const path = loop.closed_node_sequence;
  highlight(path, pathEdges(path), 'path');
  highlightFeedbackLoops();
  $('view-label').textContent = `${id} · Feedback loop`;
  const note = element('div', 'note', `The loop returns to its starting problem. Each arrow means “${arrowMeaning()}” throughout the loop.`);
  const nodes = [detailHeader('FEEDBACK LOOP'), element('div', 'detail-id', id), element('h2', '', publicLoopLabel(loop)), note];
  if (loop.condition) nodes.push(paragraph(loop.condition));
  if (loop.system === 'F5') nodes.push(paragraph('Employers may respond by paying more to retain staff or by recruiting replacements when workers leave.'));
  nodes.push(pathList(reversedArrows ? [...path].reverse() : path));
  setDetails(...nodes);
  announce(`Highlighted ${id}: ${publicLoopLabel(loop)}.`);
}
function showDirectionExplanation() {
  selectionView = { kind: 'direction', highlight: selectionView?.kind === 'direction' ? selectionView.highlight : selectionView };
  setDetails(detailHeader('READING THE MAP'),
    element('h2', '', reversedArrows ? 'Follow the arrow to what it affects.' : 'Follow the arrow to its explanation.'),
    paragraph(reversedArrows ? 'B → A means “B contributes to or worsens A”. The arrowhead points at the affected factor.' : 'A → B means “A is caused or worsened by B”. The arrowhead points at the contributing cause.'),
    element('div', 'note', reversedArrows ? 'L1 → I8 → P4: inflated land values contribute to expensive land acquisition, which increases infrastructure costs.' : 'P4 → I8 → L1: high infrastructure costs are explained in part by expensive land acquisition, which is explained by inflated land values.'),
    paragraph('An arrow does not indicate chronological order or financial flow. Each connection records a contributing mechanism under its applicable conditions.'));
}
function toggleArrowDirection() {
  const view = selectionView;
  const topic = document.querySelector('[role="tab"][aria-selected="true"]').id.replace('-tab', '');
  const open = !$('info-content').hidden, scroll = $('info-content').scrollTop;
  reversedArrows = !reversedArrows;
  graph.edges().toggleClass('reversed-arrows', reversedArrows);
  $('direction-toggle').setAttribute('aria-pressed', String(reversedArrows));
  $('direction-toggle').title = reversedArrows ? 'Switch to problems pointing towards their causes' : 'Switch to causes pointing towards effects';
  $('direction-arrow').textContent = reversedArrows ? '⟵' : '⟶';
  $('direction-meaning').textContent = reversedArrows ? 'B contributes to or worsens A' : 'A is caused or worsened by B';
  $('direction-guidance').replaceChildren(
    element('strong', '', reversedArrows ? 'Read towards the effects.' : 'Read towards the explanation.'),
    ` Each arrow means “${arrowMeaning()}” the destination factor.`);
  const highlightedView = view?.kind === 'direction' ? view.highlight : view;
  if (highlightedView?.kind === 'node') selectNode(highlightedView.id);
  if (highlightedView?.kind === 'edge') showEdge(graph.getElementById(highlightedView.id));
  if (highlightedView?.kind === 'path') showPath(highlightedView.id, false);
  if (highlightedView?.kind === 'feedback') showFeedback(highlightedView.id);
  if (view?.kind === 'direction') showDirectionExplanation();
  if (view?.unhighlighted || highlightedView?.unhighlighted) {
    removeHighlight(); selectedId = null; updateNavigation();
    $('view-label').textContent = 'Whole network';
    selectionView = { ...view };
  }
  // Keep the chosen information tab, collapsed state and viewport while updating its content.
  selectInfoTab(topic); setInfoOpen(open); $('info-content').scrollTop = scroll;
  layoutEditor.refresh();
  announce(reversedArrows ? 'Arrows now point from contributing causes towards their effects.' : 'Arrows now point from problems towards their contributing causes.');
}
function clearSelection(fit = false, preserveInfo = false) {
  if (preserveInfo && selectionView) selectionView = { ...selectionView, unhighlighted: true };
  else selectionView = null;
  if (layoutEditor?.active) layoutEditor.clearSelection();
  selectedId = null; $('feedback').value = ''; removeHighlight(); updateNavigation();
  $('view-label').textContent = 'Whole network';
  $('map-hint').textContent = layoutEditor?.active ? 'Drag nodes · Select arrows to reshape · Changes save here' : 'Scroll to zoom · Drag to pan · Select a factor';
  if (!preserveInfo) {
    const open = infoOpenBeforeSelection ?? !$('info-content').hidden;
    showOverview();
    setInfoOpen(open);
    infoOpenBeforeSelection = null;
  }
  if (fit) fitGraph();
  announce('Whole network.');
}
function fitGraph() {
  graph.stop(true, false);
  const bounds = graph.elements().boundingBox();
  const padding = window.innerWidth < 560 ? 18 : 28;
  const halfWidth = Math.max(layout.ellipses.outer.rx, Math.abs(bounds.x1), Math.abs(bounds.x2)) + 40;
  const halfHeight = Math.max(layout.ellipses.outer.ry, Math.abs(bounds.y1), Math.abs(bounds.y2)) + 40;
  const zoom = Math.max(graph.minZoom(), Math.min(graph.maxZoom(), (graph.width() - padding * 2) / (halfWidth * 2), (graph.height() - padding * 2) / (halfHeight * 2)));
  graph.viewport({ zoom, pan: { x: graph.width() / 2, y: graph.height() / 2 } });
}
function zoomBy(multiplier) {
  graph.stop(true, false);
  graph.zoom({ level: Math.max(graph.minZoom(), Math.min(graph.maxZoom(), graph.zoom() * multiplier)), renderedPosition: { x: graph.width() / 2, y: graph.height() / 2 } });
}
function syncGuides() {
  const pan = graph.pan();
  $('guide-transform').setAttribute('transform', `translate(${pan.x} ${pan.y}) scale(${graph.zoom()})`);
}
function syncLabels() {
  graph.nodes('[role = "mechanism"]').toggleClass('reading', fullLabels || graph.zoom() >= readingZoom);
  graph.nodes().toggleClass('overview', !fullLabels && graph.zoom() < overviewZoom);
}

function renderNavigation() {
  for (const id of ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']) {
    const item = button('', 'problem-button', () => selectNode(id, true));
    item.dataset.problem = id; item.setAttribute('aria-pressed', 'false');
    item.append(element('span', 'node-badge', id), element('span', '', publicLabel(model.nodes.get(id))), element('span', '', '↗'));
    $('problems').append(item);
  }
  for (const loop of feedbackSequences(model.dataset)) {
    const option = element('option', '', `${loop.id} · ${publicLoopLabel(loop)}`); option.value = loop.id; $('feedback').append(option);
  }
}
function renderSearch() {
  const query = $('search').value;
  const results = searchNodes(model, query);
  $('search-results').replaceChildren();
  $('problem-navigation').hidden = Boolean(query.trim());
  if (!query.trim()) return;
  $('search-results').append(element('div', 'search-count', results.length ? `${results.length} ${results.length === 1 ? 'factor' : 'factors'} found` : 'No matching factors. Try an ID such as P4.'));
  for (const node of results) {
    const item = button('', 'result-button', () => selectNode(node.id, true));
    item.append(element('span', 'node-badge', node.id), element('span', '', publicLabel(node)));
    $('search-results').append(item);
  }
  announce(`${results.length} search results.`);
}
function bindControls() {
  $('info-toggle').addEventListener('click', () => setInfoOpen($('info-content').hidden));
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => selectInfoTab(tab.id.replace('-tab', '')));
    tab.addEventListener('keydown', event => {
      const visible = tabs.filter(item => !item.hidden);
      const index = visible.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = visible[(index + 1) % visible.length];
      if (event.key === 'ArrowLeft') next = visible[(index + visible.length - 1) % visible.length];
      if (event.key === 'Home') next = visible[0];
      if (event.key === 'End') next = visible.at(-1);
      if (next) { event.preventDefault(); next.click(); next.focus(); }
    });
  }
  $('search').addEventListener('input', renderSearch);
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    const result = searchNodes(model, $('search').value)[0];
    if (result) selectNode(result.id, true);
  });
  $('feedback').addEventListener('change', () => $('feedback').value ? showFeedback($('feedback').value) : clearSelection());
  $('zoom-in').addEventListener('click', () => zoomBy(1.3));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
  $('fit').addEventListener('click', fitGraph);
  $('reset').addEventListener('click', () => {
    $('search').value = ''; renderSearch(); fullLabels = false;
    $('labels-toggle').setAttribute('aria-pressed', 'false'); $('labels-toggle').textContent = 'Show full labels';
    clearSelection(true, true); syncLabels();
  });
  $('labels-toggle').addEventListener('click', () => {
    fullLabels = !fullLabels; $('labels-toggle').setAttribute('aria-pressed', String(fullLabels));
    $('labels-toggle').textContent = fullLabels ? 'Automatic labels' : 'Show full labels'; syncLabels();
  });
  $('direction-info').addEventListener('click', showDirectionExplanation);
  $('direction-toggle').addEventListener('click', toggleArrowDirection);
  document.addEventListener('keydown', event => {
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (event.key === '/' && !editing) { event.preventDefault(); $('search').focus(); }
    if (event.key === 'Escape') { if (editing) { $('search').value = ''; renderSearch(); } if (layoutEditor?.active) layoutEditor.clearSelection(); else clearSelection(); }
  });
  $('cy').addEventListener('keydown', event => {
    if (layoutEditor?.keydown(event)) return;
    const shifts = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
    if (shifts[event.key]) { event.preventDefault(); const [x, y] = shifts[event.key]; graph.panBy({ x, y }); }
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomBy(event.key === '-' ? 1 / 1.3 : 1.3); }
    if (event.key === 'Home') { event.preventDefault(); fitGraph(); }
  });
  graph.on('tap', 'node', event => selectNode(event.target.id()));
  graph.on('tap', 'edge', event => layoutEditor?.active ? layoutEditor.selectEdge(event.target) : showEdge(event.target));
  graph.on('tap', event => { if (event.target === graph) { if (layoutEditor?.active) layoutEditor.clearSelection(); else clearSelection(); } });
  graph.on('pan zoom', syncGuides);
  graph.on('zoom', syncLabels);
  new ResizeObserver(() => { graph.resize(); syncGuides(); }).observe($('map-surface'));
}

async function init() {
  await loadLogo();
  try {
    const [dataResponse, layoutResponse] = await Promise.all([fetch('./Fusion_Land_Value_Causal_Network.json'), fetch('./assets/layout.json')]);
    if (!dataResponse.ok || !layoutResponse.ok) throw new Error('The dataset or saved layout could not be loaded.');
    const raw = await dataResponse.arrayBuffer();
    model = createModel(JSON.parse(new TextDecoder().decode(raw)));
    layout = await layoutResponse.json();
    if (crypto.subtle) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(n => n.toString(16).padStart(2, '0')).join('');
      if (hash !== layout.datasetSha256) throw new Error('The saved layout belongs to a different dataset version.');
    }
    if (model.nodes.size !== Object.keys(layout.positions).length || [...model.nodes.keys()].some(id => !Number.isFinite(layout.positions[id]?.x) || !Number.isFinite(layout.positions[id]?.y))) throw new Error('The saved layout does not cover every canonical factor.');
    if (!window.cytoscape) throw new Error('The local graph library could not be loaded.');
    graph = window.cytoscape({
      container: $('cy'), elements: toElements(model.dataset).map(item => item.group === 'nodes' ? { ...item, data: { ...item.data, publicLabel: publicLabel(item.data) } } : item), layout: { name: 'preset', positions: layout.positions, fit: false },
      minZoom: .025, maxZoom: 2.5, wheelSensitivity, autoungrabify: true, boxSelectionEnabled: false, autounselectify: true,
      style: [
        { selector: 'node', style: { shape: 'round-rectangle', width: 166, height: 80, 'background-color': '#e5ebdd', 'border-width': 1.5, 'border-color': '#afbea3', label: 'data(id)', color: '#4d6654', 'font-size': 26, 'font-family': 'Segoe UI, Arial, sans-serif', 'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap', 'text-max-width': 148, 'text-events': 'no', 'overlay-opacity': 0 } },
        { selector: 'node[role = "mechanism"].reading', style: { label: node => `${node.id()}: ${node.data('publicLabel')}`, 'font-size': 15, 'text-opacity': 0 } },
        { selector: 'node[role = "problem"]', style: { width: 265, height: 125, 'background-color': '#eee8f3', 'border-color': '#8f7ba5', 'border-width': 3, label: node => `${node.id()}\n${node.data('publicLabel')}`, 'font-size': 24, 'font-weight': 600, 'text-max-width': 235, 'line-height': 1.1, color: '#50415e' } },
        { selector: '#L1', style: { width: 250, height: 135, 'background-color': '#1b7568', 'border-color': '#105e54', 'border-width': 3, label: node => `${node.id()}\n${node.data('publicLabel')}`, color: '#ffffff', 'font-size': 30, 'font-weight': 600, 'text-max-width': 225 } },
        { selector: 'node.overview', style: { label: 'data(id)', 'font-size': 40 } },
        { selector: 'edge', style: { width: 2.3, 'line-color': '#a5b59b', 'source-arrow-color': '#8a9f80', 'target-arrow-color': '#8a9f80', 'source-arrow-shape': 'none', 'target-arrow-shape': 'triangle', 'arrow-scale': 1.5, 'curve-style': 'bezier', opacity: .65, 'overlay-opacity': 0, 'line-cap': 'round' } },
        { selector: 'edge.reversed-arrows', style: { 'source-arrow-shape': 'triangle', 'target-arrow-shape': 'none' } },
        { selector: '.muted', style: { opacity: mutedOpacity } },
        { selector: '.extended', style: { opacity: extendedOpacity } },
        { selector: 'node.highlighted, node.extended', style: { 'background-color': '#e5ebdd', color: '#4d6654', 'border-color': '#115e53', 'border-width': 3, 'z-index': 5 } },
        { selector: 'node.downstream', style: { 'background-color': '#d1e8e3' } },
        { selector: 'node.highlighted.incoming, node.extended.incoming', style: { 'background-color': '#eee8f3', color: '#50415e', 'border-color': '#8f7ba5' } },
        { selector: 'node[role = "problem"].downstream', style: { 'background-color': '#eee8f3', color: '#50415e', 'border-color': '#115e53', 'font-weight': 600 } },
        { selector: 'node.selected', style: { 'border-color': '#537b60', 'border-width': 6, 'z-index': 10, 'underlay-color': '#537b60', 'underlay-opacity': .13, 'underlay-padding': 14 } },
        { selector: 'node[role = "problem"].selected, node[role = "problem"].core-problem', style: { 'background-color': '#8f7ba5', 'border-color': '#8f7ba5', color: '#ffffff' } },
        { selector: '#L1', style: { 'background-color': '#1b7568', color: '#ffffff', 'border-color': '#105e54', 'border-width': 3, 'underlay-opacity': 0, opacity: 1 } },
        { selector: 'node[id = "L1"].core-problem', style: { 'border-color': '#8f7ba5', 'border-width': 6 } },
        { selector: 'node[role = "problem"].overview, node[id = "L1"].overview', style: { label: 'data(id)', 'font-size': 70, 'font-weight': 600 } },
        { selector: 'edge.highlighted, edge.path-edge, edge.selected, edge.extended', style: { 'line-color': '#1b7568', 'source-arrow-color': '#1b7568', 'target-arrow-color': '#1b7568', width: 5, opacity: 1, 'z-index': 8 } },
        { selector: 'edge.extended', style: { opacity: extendedOpacity } },
        { selector: 'edge.highlighted.incoming, edge.extended.incoming', style: { 'line-color': '#8f7ba5', 'source-arrow-color': '#8f7ba5', 'target-arrow-color': '#8f7ba5' } },
        { selector: 'edge.path-edge', style: { width: 6, 'arrow-scale': 1.8 } },
        { selector: '.feedback-loop', style: { opacity: 1 } },
        { selector: 'node.feedback-tint', style: { 'border-color': feedbackColour, 'border-width': 3 } },
        { selector: 'node.feedback-tint[role = "mechanism"]', style: { 'background-color': '#fff0d6', color: '#744711' } },
        { selector: 'node.feedback-tint[role = "problem"]', style: { 'background-color': '#eee8f3', color: '#50415e' } },
        { selector: 'edge.feedback-loop', style: { 'line-color': feedbackColour, 'source-arrow-color': feedbackColour, 'target-arrow-color': feedbackColour, width: 5, 'z-index': 8 } },
        { selector: 'node.edit-selected', style: { 'border-color': '#173e3b', 'border-width': 5, 'z-index': 10 } },
        { selector: 'edge.edit-selected', style: { 'line-color': '#1b7568', 'source-arrow-color': '#1b7568', 'target-arrow-color': '#1b7568', width: 5, opacity: 1, 'z-index': 10 } }
      ]
    });
    createNodeLabels(graph);
    for (const [id, points] of Object.entries(layout.edgeRoutes ?? {})) applyEdgeRoute(graph.getElementById(id), points);
    layoutEditor = createLayoutEditor({ graph, layout, clearView: () => { clearSelection(); setInfoOpen(false); }, edgeLabel: edge => connectionLabel(edge.data()) });
    for (const ring of ['inner', 'outer']) {
      const ellipse = document.querySelector(`.${ring}-guide`);
      ellipse.setAttribute('rx', layout.ellipses[ring].rx); ellipse.setAttribute('ry', layout.ellipses[ring].ry);
    }
    $('counts').textContent = `${model.nodes.size} problems, ${model.dataset.canonical.edges.length} connections, ${model.dataset.structural_annotations.feedback_loops.length} feedback loops`;
    renderNavigation(); bindControls(); showOverview(); fitGraph(); syncGuides(); syncLabels();
    $('loading').hidden = true;
    document.body.dataset.ready = 'true';
  } catch (error) {
    console.error(error);
    $('loading').replaceChildren(element('div', 'error', `Unable to open the network. ${error.message} Please reload the page. If the problem persists, serve this folder over HTTP.`));
    document.body.dataset.ready = 'error';
  }
}

init();
