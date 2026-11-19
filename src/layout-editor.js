const clone = value => structuredClone(value);

// Routes stay in graph coordinates; Cytoscape's segment values depend on both endpoints.
export function applyEdgeRoute(edge, points = []) {
  const a = edge.source().position(), b = edge.target().position();
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  if (!points.length || squared < .000001) {
    edge.style('curve-style', 'straight');
    return;
  }
  edge.style({ 'curve-style': 'segments', 'edge-distances': 'node-position',
    'segment-weights': points.map(p => ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared),
    'segment-distances': points.map(p => (dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.sqrt(squared))
  });
}

export function createLayoutEditor({ graph, layout, clearView, edgeLabel = edge => `${edge.source().id()} → ${edge.target().id()}` }) {
  const $ = id => document.getElementById(id);
  const overlay = $('layout-handles');
  const baseline = clone({ positions: layout.positions, edgeRoutes: layout.edgeRoutes });
  const storageKey = `fusion-layout-editor:${layout.datasetSha256}`;
  // A regenerated drawing must not silently receive an older draft.
  const baseGeometry = JSON.stringify(baseline);
  const undo = [], redo = [];
  let active = false, selection = null, bend = null, nodeDrag = null, handleDrag = null, restoring = false;
  const snapshot = () => clone({ positions: layout.positions, edgeRoutes: layout.edgeRoutes });
  const status = message => { $('layout-save-status').textContent = message; };
  function updateHistory() {
    $('layout-undo').disabled = !undo.length;
    $('layout-redo').disabled = !redo.length;
  }
  function save() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ baseGeometry, ...snapshot() }));
      status('Saved in this browser. Export a file to keep a backup.');
    } catch { status('Browser saving is unavailable. Export your layout to keep your changes.'); }
  }
  function commit(before) {
    if (JSON.stringify(before) === JSON.stringify(snapshot())) return;
    undo.push(before);
    if (undo.length > 100) undo.shift();
    redo.length = 0;
    updateHistory(); save();
  }
  function validate(value) {
    if (!value || typeof value !== 'object') throw new Error('Choose a layout JSON file.');
    if (value.datasetSha256 !== undefined && value.datasetSha256 !== layout.datasetSha256) throw new Error('This layout belongs to a different dataset.');
    const validPoint = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 1e7 && Math.abs(p.y) <= 1e7;
    const positions = value.positions, routes = value.edgeRoutes;
    if (!positions || Object.keys(positions).length !== graph.nodes().length || graph.nodes().some(n => !validPoint(positions[n.id()]))) throw new Error('The layout must contain a valid position for every factor.');
    if (!routes || Object.keys(routes).length !== graph.edges().length || graph.edges().some(e => !Array.isArray(routes[e.id()]) || routes[e.id()].length > 2000 || !routes[e.id()].every(validPoint))) throw new Error('The layout must contain valid bend lists for every connection.');
    return clone({ positions, edgeRoutes: routes });
  }
  function restore(value) {
    restoring = true;
    layout.positions = clone(value.positions);
    layout.edgeRoutes = clone(value.edgeRoutes);
    graph.batch(() => {
      graph.nodes().positions(n => layout.positions[n.id()]);
      graph.edges().forEach(e => applyEdgeRoute(e, layout.edgeRoutes[e.id()]));
    });
    restoring = false;
    bend = null; render();
  }
  function travel(direction) {
    const from = direction === 'undo' ? undo : redo, to = direction === 'undo' ? redo : undo;
    if (!from.length) return;
    to.push(snapshot()); restore(from.pop()); updateHistory(); save();
  }
  function select(item, index = null) {
    graph.elements().removeClass('edit-selected');
    selection = item; bend = index;
    if (item) item.addClass('edit-selected');
    render();
  }
  function coordinates() {
    if (!selection) return null;
    return selection.isNode() ? selection.position() : bend !== null ? layout.edgeRoutes[selection.id()][bend] : null;
  }
  function svgElement(tag, attributes) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    return el;
  }
  function addHandle(point, index, insert) {
    const pan = graph.pan(), zoom = graph.zoom();
    const x = point.x * zoom + pan.x, y = point.y * zoom + pan.y;
    const group = svgElement('g', { class: `bend-handle${insert ? ' insert-handle' : ''}${!insert && bend === index ? ' is-selected' : ''}`, tabindex: 0, role: 'button', 'aria-label': insert ? `Add bend on segment ${index + 1}` : `Move bend ${index + 1}. Arrow keys move; Delete removes.`, transform: `translate(${x} ${y})`, 'data-index': index, 'data-insert': String(insert) });
    group.append(svgElement('circle', { r: insert ? 8 : 9 }));
    if (insert) { const label = svgElement('text', { 'text-anchor': 'middle', dy: '.35em' }); label.textContent = '+'; group.append(label); }
    group.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      const before = snapshot();
      if (insert) layout.edgeRoutes[selection.id()].splice(index, 0, { ...point });
      bend = index;
      handleDrag = { before, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, point: { ...point }, moved: false };
      overlay.setPointerCapture(event.pointerId);
      applyEdgeRoute(selection, layout.edgeRoutes[selection.id()]); render();
    });
    group.addEventListener('keydown', event => {
      if (insert && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        const before = snapshot(); layout.edgeRoutes[selection.id()].splice(index, 0, { ...point }); bend = index;
        applyEdgeRoute(selection, layout.edgeRoutes[selection.id()]); render(); commit(before); focusBend();
      } else if (!insert) {
        bend = index;
        if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); removeBend(); }
        else if (nudge(event)) focusBend();
      }
    });
    group.addEventListener('focus', () => {
      if (!insert) { bend = index; updateFields(); }
    });
    overlay.append(group);
  }
  function updateFields() {
    const point = coordinates();
    $('layout-coordinates').hidden = !point;
    if (point) { $('layout-x').value = +point.x.toFixed(2); $('layout-y').value = +point.y.toFixed(2); }
    $('layout-remove-bend').disabled = bend === null;
    $('layout-selection').textContent = !selection ? 'Select a node or arrow to edit.' : selection.isNode() ? `Node ${selection.id()} · arrow keys on the canvas move it` : `${edgeLabel(selection)}${bend === null ? ' · select a bend or drag a + handle' : ` · bend ${bend + 1}`}`;
  }
  function render() {
    overlay.replaceChildren();
    updateFields();
    $('layout-edge-actions').hidden = !selection?.isEdge();
    if (!active || !selection?.isEdge()) return;
    const points = layout.edgeRoutes[selection.id()];
    const path = [selection.source().position(), ...points, selection.target().position()];
    // Insert handles precede real bends, so bends remain reachable on short segments.
    for (let i = 0; i < path.length - 1; i++) addHandle({ x: (path[i].x + path[i + 1].x) / 2, y: (path[i].y + path[i + 1].y) / 2 }, i, true);
    points.forEach((point, i) => addHandle(point, i, false));
  }
  function focusBend() { overlay.querySelector(`[data-insert="false"][data-index="${bend}"]`)?.focus({ preventScroll: true }); }
  function removeBend() {
    if (!selection?.isEdge() || bend === null) return;
    const before = snapshot(); layout.edgeRoutes[selection.id()].splice(bend, 1); bend = null;
    applyEdgeRoute(selection, layout.edgeRoutes[selection.id()]); render(); commit(before);
  }
  // Preserve neighbouring route shapes by distributing an endpoint move along each route.
  function moveNode(node, point, before) {
    const old = before.positions[node.id()], delta = { x: point.x - old.x, y: point.y - old.y };
    graph.batch(() => {
      node.position(point); layout.positions[node.id()] = { ...point };
      node.connectedEdges().forEach(edge => {
        const points = before.edgeRoutes[edge.id()] ?? [];
        const path = [before.positions[edge.source().id()], ...points, before.positions[edge.target().id()]];
        const distances = path.map((p, i) => i ? Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) : 0);
        const total = distances.reduce((a, b) => a + b, 0);
        let travelled = 0;
        layout.edgeRoutes[edge.id()] = points.map((p, i) => {
          travelled += distances[i + 1];
          const fraction = total ? travelled / total : .5;
          const weight = edge.source().id() === node.id() ? 1 - fraction : fraction;
          return { x: p.x + delta.x * weight, y: p.y + delta.y * weight };
        });
        applyEdgeRoute(edge, layout.edgeRoutes[edge.id()]);
      });
    });
    render();
  }
  function setPoint(point) {
    const before = snapshot();
    if (selection.isNode()) moveNode(selection, point, before);
    else { layout.edgeRoutes[selection.id()][bend] = point; applyEdgeRoute(selection, layout.edgeRoutes[selection.id()]); render(); }
    commit(before);
  }
  function nudge(event) {
    const shifts = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const point = coordinates(), shift = shifts[event.key];
    if (!point || !shift) return false;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 10 : 1;
    setPoint({ x: point.x + shift[0] * step, y: point.y + shift[1] * step });
    return true;
  }
  overlay.addEventListener('pointermove', event => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    const dx = event.clientX - handleDrag.startX, dy = event.clientY - handleDrag.startY;
    handleDrag.moved ||= Math.hypot(dx, dy) > 2;
    layout.edgeRoutes[selection.id()][bend] = { x: handleDrag.point.x + dx / graph.zoom(), y: handleDrag.point.y + dy / graph.zoom() };
    applyEdgeRoute(selection, layout.edgeRoutes[selection.id()]); render();
  });
  function finishHandle(event) {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    const { before } = handleDrag;
    handleDrag = null;
    if (overlay.hasPointerCapture(event.pointerId)) overlay.releasePointerCapture(event.pointerId);
    if (event.type === 'pointercancel') restore(before); else commit(before);
    focusBend();
  }
  overlay.addEventListener('pointerup', finishHandle);
  overlay.addEventListener('pointercancel', finishHandle);
  graph.on('grab', 'node', event => { if (active) { nodeDrag = snapshot(); select(event.target); } });
  graph.on('drag', 'node', event => { if (active && nodeDrag && !restoring) moveNode(event.target, { ...event.target.position() }, nodeDrag); });
  graph.on('free', 'node', () => { if (nodeDrag) { commit(nodeDrag); nodeDrag = null; } });
  graph.on('pan zoom resize', render);
  $('layout-toggle').addEventListener('click', () => {
    active = !active; clearView(); select(null);
    graph.autoungrabify(!active);
    $('layout-editor').hidden = !active; overlay.toggleAttribute('hidden', !active);
    $('layout-toggle').setAttribute('aria-pressed', String(active));
    $('layout-toggle').textContent = active ? 'Done editing' : 'Edit layout';
    $('feedback').disabled = active;
    $('map-hint').textContent = active ? 'Drag nodes · Select arrows to reshape · Changes save here' : 'Scroll to zoom · Drag to pan · Select a factor';
    document.body.classList.toggle('editing-layout', active);
  });
  $('layout-undo').addEventListener('click', () => travel('undo'));
  $('layout-redo').addEventListener('click', () => travel('redo'));
  $('layout-remove-bend').addEventListener('click', removeBend);
  $('layout-straighten').addEventListener('click', () => {
    if (!selection?.isEdge()) return;
    const before = snapshot(); layout.edgeRoutes[selection.id()] = []; bend = null;
    applyEdgeRoute(selection, []); render(); commit(before);
  });
  $('layout-apply').addEventListener('click', () => {
    if (!coordinates()) return;
    const x = $('layout-x').valueAsNumber, y = $('layout-y').valueAsNumber;
    if (![x, y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)) { status('Enter valid X and Y coordinates.'); return; }
    setPoint({ x, y });
  });
  $('layout-restore').addEventListener('click', () => { const before = snapshot(); restore(baseline); commit(before); status('Original layout restored. Undo is available.'); });
  $('layout-export').addEventListener('click', () => {
    const output = { ...layout, ...snapshot(), manualEdits: { savedAt: new Date().toISOString(), baseLayoutVersion: layout.version }, description: 'Manually arranged network. Generated geometry reports describe the original drawing.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'layout.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status('Layout exported. Keep the file as a backup or import it on another browser.');
  });
  $('layout-import').addEventListener('click', () => $('layout-file').click());
  $('layout-file').addEventListener('change', async () => {
    const file = $('layout-file').files[0];
    if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error('The layout file is too large.');
      const value = validate(JSON.parse(await file.text()));
      const before = snapshot(); restore(value); commit(before); status('Layout imported and saved in this browser. Undo is available.');
    } catch (error) { status(`Import failed: ${error.message}`); }
    $('layout-file').value = '';
  });
  document.addEventListener('keydown', event => {
    if (!active || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); travel(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
    }
  });
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const draft = JSON.parse(saved);
      if (draft.baseGeometry === baseGeometry) { restore(validate(draft)); status('Your saved layout has been restored. Export a file to keep a backup.'); }
      else status('The original drawing has changed. Import an exported layout to reuse earlier work.');
    }
  } catch { status('The saved draft could not be loaded. Import a backup or start editing.'); }
  return {
    refresh: render,
    get active() { return active; },
    selectNode(id, focus = false) { const node = graph.getElementById(id); select(node); if (focus) graph.animate({ center: { eles: node }, zoom: Math.max(graph.zoom(), .65) }, { duration: 0 }); },
    selectEdge: edge => select(edge),
    clearSelection: () => select(null),
    keydown: event => active && nudge(event)
  };
}
