// Cytoscape labels have one font weight. A DOM layer lets regular labels keep
// a semibold ID and normal body text while the graph still measures the label.
export function createNodeLabels(graph) {
  const layer = document.createElement('div');
  layer.className = 'node-label-layer';
  layer.setAttribute('aria-hidden', 'true');
  const viewport = document.createElement('div');
  viewport.className = 'node-label-viewport';
  layer.append(viewport);
  graph.container().append(layer);

  const labels = graph.nodes('[role = "mechanism"]').map(node => {
    const label = document.createElement('div');
    label.className = 'node-label';
    label.dataset.nodeId = node.id();
    const id = document.createElement('strong');
    id.textContent = `${node.id()}:`;
    label.append(id, ` ${node.data('publicLabel')}`);
    viewport.append(label);
    return { node, label };
  });
  const styles = new WeakMap();
  const setStyle = (element, property, value) => {
    if (!styles.has(element)) styles.set(element, {});
    const previous = styles.get(element);
    if (previous[property] !== value) {
      element.style[property] = value;
      previous[property] = value;
    }
  };
  function render() {
    const pan = graph.pan(), zoom = graph.zoom();
    setStyle(viewport, 'transform', `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`);
    for (const { node, label } of labels) {
      const hidden = !node.hasClass('reading') || node.hasClass('overview') || !node.visible();
      if (label.hidden !== hidden) label.hidden = hidden;
      if (label.hidden) continue;
      const position = node.position();
      setStyle(label, 'left', `${position.x}px`);
      setStyle(label, 'top', `${position.y}px`);
      setStyle(label, 'width', node.style('text-max-width'));
      setStyle(label, 'fontSize', node.style('font-size'));
      setStyle(label, 'fontFamily', node.style('font-family'));
      setStyle(label, 'color', node.style('color'));
      setStyle(label, 'opacity', String(node.effectiveOpacity()));
    }
  }
  graph.on('render', render);
  graph.on('destroy', () => layer.remove());
  render();
}
