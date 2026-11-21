import React, { useEffect, useMemo, useRef, useState } from 'react';
import { runtime, useValue, readPreference, writePreference } from '../../data/hooks';
import { useTasks } from '../../data/tasks/TaskStore';
import { ROUTES } from '../../navigation/routes';
import { NODE_WIDTH as W, NODE_HEIGHT as H, PORTS, port, nearestAnchor, toWorld, zoomAt, fitView, routeConnection, routeGraphConnections, pathData,segmentWaypoints } from './graphGeometry.mjs';
const edgeKey = (a, b) => [a, b].sort().join('|');
const typeName = kind => kind === 'memo' ? '문서' : kind === 'event' ? '일정' : '할 일';
const sideName = {
  left: '왼쪽',
  right: '오른쪽',
  top: '위쪽',
  bottom: '아래쪽'
};
// Keep the camera when returning from an editor; a new account/runtime gets its own cache.
const cameraCache = new WeakMap();
const bounded = point => ({
  x: Math.max(-99999, Math.min(99999, point.x)),
  y: Math.max(-99999, Math.min(99999, point.y))
});
export default function GraphCanvas({
  navigation
}) {
  const own = runtime();
  const documents = useValue(() => own.documents.listDocuments());
  const tasks = useTasks();
  const workspaceId = own.store.getCurrentWorkspace().id;
  const taskPositionKey = `stella-graph-tasks:${workspaceId}`;
  const routePreferenceKey=`stella-graph-routes:${workspaceId}`;
  const [routeOverrides,setRouteOverrides]=useState(()=>readPreference(routePreferenceKey,{}));
  const routeDraft=useRef(null);
  if (!cameraCache.has(own)) cameraCache.set(own, new Map());
  const savedCamera = cameraCache.get(own).get(workspaceId);
  const [positions, setPositions] = useState(() => readPreference(taskPositionKey, {}));
  const [view, setView] = useState(savedCamera || {
    x: 24,
    y: 24,
    zoom: 1
  });
  const [size, setSize] = useState({
    width: 0,
    height: 0
  });
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState('select');
  const [connection, setConnection] = useState(null);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  const stage = useRef(null),
    current = useRef({}),
    gesture = useRef(null),
    pointers = useRef(new Map());
  const initialized = useRef(Boolean(savedCamera)),
    space = useRef(false),
    connectionRef = useRef(null);
  useEffect(() => {
    cameraCache.get(own).set(workspaceId, view);
  }, [own, workspaceId, view]);
  const scene = useMemo(() => {
    const nodes = documents.map((doc, i) => ({
      key: `m:${doc.id}`,
      id: doc.id,
      kind: 'memo',
      title: doc.title || '제목 없는 문서',
      x: doc.x ?? i % 2 * 300,
      y: doc.y ?? Math.floor(i / 2) * 180
    }));
    const edges = [];
    for (const doc of documents) {
      if (doc.parentId) edges.push({
        a: `m:${doc.parentId}`,
        b: `m:${doc.id}`,
        kind: 'hierarchy'
      });
      for (const taskId of doc.taskIds) {
        const task = tasks.find(t => t.id === taskId);
        if (!task) continue;
        if (!nodes.some(n => n.key === `t:${taskId}`)) nodes.push({
          key: `t:${taskId}`,
          id: taskId,
          kind: task.kind,
          title: task.title,
          x: 300,
          y: Math.ceil(nodes.length / 2) * 180
        });
        edges.push({
          a: `m:${doc.id}`,
          b: `t:${taskId}`,
          kind: 'task'
        });
      }
    }
    for (const link of own.documents.links()) edges.push({
      a: `m:${link.source}`,
      b: `m:${link.target}`,
      kind: link.kind,
      anchors: link.anchors
    });
    const keys = new Set(nodes.map(n => n.key));
    const unique = new Map();
    for (const edge of edges) {
      if (!keys.has(edge.a) || !keys.has(edge.b)) continue;
      const key = edgeKey(edge.a, edge.b);
      // A structural/source relationship cannot be erased by deleting its duplicate manual link.
      const previous = unique.get(key);
      const relationship = !previous || edge.kind !== 'manual' ? edge : previous;
      const positioned = edge.anchors ? edge : previous?.anchors ? previous : null;
      unique.set(key, {
        ...relationship,
        key,
        anchors: positioned ? positioned.a === relationship.a ? positioned.anchors : {
          source: positioned.anchors.target,
        target: positioned.anchors.source,
        ...(positioned.anchors.via ? {via:[...positioned.anchors.via].reverse()} : {})
        } : null
      });
    }
    return {
      nodes,
      edges: [...unique.values()]
    };
  }, [documents, tasks, own]);
  const nodes = useMemo(() => scene.nodes.map(n => ({
    ...n,
    ...(positions[n.key] || {}),
    width: W,
    height: H
  })), [scene, positions]);
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const routes = useMemo(() => {
    return routeGraphConnections(nodes, scene.edges.map(edge=>({...edge,anchors:routeOverrides[edge.key] || edge.anchors})));
  }, [scene, nodes,routeOverrides]);
  current.current = {
    view,
    nodes,
    byKey,
    positions,
    selected,
    mode,
    scene,routes,routeOverrides
  };
  connectionRef.current = connection;
  const selectedNode = selected?.node ? byKey.get(selected.node) : null;
  const selectedEdge = scene.edges.find(e => e.key === selected?.edge);
  const selectedRoute=routes.find(e=>e.key===selected?.edge);
  function saveRoute(edge,anchors) {
    if(!routeConnection(current.current.byKey.get(edge.a),current.current.byKey.get(edge.b),current.current.nodes,anchors).length)throw new Error('노드를 통과하는 경로입니다. 빈 공간으로 옮겨 주세요.');
    const a=current.current.byKey.get(edge.a),b=current.current.byKey.get(edge.b);
    if(a.kind==='memo'&&b.kind==='memo')own.documents.setLink(a.id,b.id,true,anchors);
    else writePreference(routePreferenceKey,{...readPreference(routePreferenceKey,{}),[edge.key]:anchors});
  }
  function updateRoute(key,anchors){routeDraft.current=anchors;setRouteOverrides(previous=>({...previous,[key]:anchors}));}
  function resetRoute(){
    if(!selectedRoute)return;
    const anchors={source:selectedRoute.anchors.source,target:selectedRoute.anchors.target};
    try{saveRoute(selectedRoute,anchors);updateRoute(selectedRoute.key,anchors);setError('');}catch(e){setError(e.message);}
  }
  function fit() {
    if (size.width) setView(fitView(current.current.nodes, size));
  }
  useEffect(() => {
    const element = stage.current;
    const observer = new ResizeObserver(([entry]) => setSize({
      width: entry.contentRect.width,
      height: entry.contentRect.height
    }));
    observer.observe(element);
    const wheel = event => {
      event.preventDefault();
      if (gesture.current || connectionRef.current) return;
      const rect = element.getBoundingClientRect();
      const point = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
      };
      setView(previous => zoomAt(previous, point, previous.zoom * Math.exp(-event.deltaY * .0015)));
    };
    element.addEventListener('wheel', wheel, {
      passive: false
    });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, []);
  useEffect(() => {
    if (!initialized.current && size.width && size.height) {
      initialized.current = true;
      fit();
    }
  }, [size]);
  function local(event) {
    const rect = stage.current.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }
  function open(node) {
    navigation.navigate(node.kind === 'memo' ? ROUTES.MemoEdit : ROUTES.TaskEdit, node.kind === 'memo' ? {
      memoId: node.id
    } : {
      taskId: node.id
    });
  }
  function savePosition(node, point) {
    try {
      if (node.kind === 'memo') own.documents.savePosition(node.id, point.x, point.y);else writePreference(taskPositionKey, Object.fromEntries(Object.entries(current.current.positions).filter(([key]) => key.startsWith('t:'))));
      setError('');
    } catch (e) {
      setError(`위치를 저장하지 못했습니다. ${e.message}`);
      setPositions(previous => {
        const next = {
          ...previous
        };
        delete next[node.key];
        return next;
      });
    }
  }
  function moveNode(key, point) {
    const value = bounded(point);
    current.current.positions = {
      ...current.current.positions,
      [key]: value
    };
    setPositions(current.current.positions);
  }
  function link(source, target, targetAnchor) {
    if (source === target) {
      setError('서로 다른 문서를 연결하세요.');
      return;
    }
    try {
      const a = current.current.byKey.get(source),
        b = current.current.byKey.get(target);
      if (a?.kind !== 'memo' || b?.kind !== 'memo') throw new Error('이 핸들은 문서 간 연결용입니다. 할 일 연결은 문서 편집에서 관리하세요.');
      const active = connectionRef.current;
      const end = targetAnchor || active?.targetAnchor || nearestAnchor(b, port(a, active?.side || 'right', active?.offset ?? .5));
      own.documents.setLink(a.id, b.id, true, {
        source: {
          side: active?.side || 'right',
          offset: active?.offset ?? .5
        },
        target: end
      });
      setRouteOverrides(previous=>{const next={...previous};delete next[edgeKey(source,target)];return next;});
      setSelected({
        edge: edgeKey(source, target)
      });
      setError('');
    } catch (e) {
      setError(e.message);
    }
    setConnection(null);
    connectionRef.current = null;
  }
  function removeLink() {
    if (!selectedEdge || selectedEdge.kind !== 'manual') return;
    try {
      own.documents.setLink(byKey.get(selectedEdge.a).id, byKey.get(selectedEdge.b).id, false);
      setRouteOverrides(previous=>{const next={...previous};delete next[selectedEdge.key];return next;});
      setSelected(null);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  function cancelGesture() {
    const drag = gesture.current;
    if (drag?.kind === 'node') moveNode(drag.key, drag.origin);
    if(drag?.kind==='segment'||drag?.kind==='endpoint')updateRoute(drag.edge.key,drag.original);
    gesture.current = null;
    pointers.current.clear();
    setMoving(false);
    setConnection(null);
    connectionRef.current = null;
  }
  function down(event) {
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    stage.current.focus({
      preventScroll: true
    });
    const point = local(event);
    pointers.current.set(event.pointerId, point);
    stage.current.setPointerCapture(event.pointerId);
    if (pointers.current.size === 2) {
      const prior = gesture.current;
      if (prior?.kind === 'node') {
        const node = current.current.byKey.get(prior.key);
        savePosition(node, current.current.positions[prior.key] || prior.origin);
      }
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        kind: 'pinch',
        view: current.current.view,
        mid: {
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2
        },
        distance: Math.hypot(a.x - b.x, a.y - b.y)
      };
      setConnection(null);
      setMoving(true);
      return;
    }
    const nodeElement = event.target.closest('[data-node]');
    const nodeKey = nodeElement?.dataset.node;
    const handle = event.target.closest('[data-port]');
    const border = event.target.closest('[data-border]');
    const edge = event.target.closest('[data-edge]');
    const routeEnd=event.target.closest('[data-edge-end]');
    if (event.button === 1 || space.current || current.current.mode === 'pan') {
      gesture.current = {
        kind: 'pan',
        point,
        view: current.current.view
      };
      setMoving(true);
      return;
    }
    if(routeEnd){
      const route=current.current.routes.find(r=>r.key===routeEnd.dataset.edgeKey);
      gesture.current={kind:'endpoint',edge:route,end:routeEnd.dataset.edgeEnd,original:route.anchors,point,view:current.current.view};
      setSelected({edge:route.key});return;
    }
    if (connectionRef.current && nodeKey) {
      const targetNode = current.current.byKey.get(nodeKey);
      link(connectionRef.current.source, nodeKey, handle ? {
        side: handle.dataset.port,
        offset: Number(handle.dataset.offset)
      } : nearestAnchor(targetNode, toWorld(point, current.current.view)));
      gesture.current = {
        kind: 'done'
      };
      return;
    }
    if ((handle || border) && nodeKey) {
      const anchor = handle ? {
        side: handle.dataset.port,
        offset: Number(handle.dataset.offset)
      } : nearestAnchor(current.current.byKey.get(nodeKey), toWorld(point, current.current.view));
      const next = {
        source: nodeKey,
        ...anchor,
        point: toWorld(point, current.current.view),
        target: null
      };
      setConnection(next);
      connectionRef.current = next;
      gesture.current = {
        kind: 'connect',
        point
      };
      return;
    }
    if (nodeKey) {
      setSelected({
        node: nodeKey
      });
      const node = current.current.byKey.get(nodeKey);
      gesture.current = {
        kind: 'node',
        key: nodeKey,
        point,
        origin: {
          x: node.x,
          y: node.y
        },
        view: current.current.view,
        moved: false
      };
    } else if (edge) {
      setSelected({
        edge: edge.dataset.edge
      });
      const route=current.current.routes.find(r=>r.key===edge.dataset.edge);
      const world=toWorld(point,current.current.view);
      let index=1,best=Infinity;
      for(let i=1;i<route.points.length;i++){const a=route.points[i-1],b=route.points[i];const distance=a.x===b.x?Math.abs(world.x-a.x)+Math.max(Math.min(a.y,b.y)-world.y,0,world.y-Math.max(a.y,b.y)):Math.abs(world.y-a.y)+Math.max(Math.min(a.x,b.x)-world.x,0,world.x-Math.max(a.x,b.x));if(distance<best){best=distance;index=i;}}
      gesture.current={kind:'segment',edge:route,index,original:route.anchors,point,view:current.current.view};
    } else {
      setSelected(null);
      setConnection(null);
      connectionRef.current = null;
      gesture.current = {
        kind: 'pan',
        point,
        view: current.current.view
      };
      setMoving(true);
    }
  }
  function move(event) {
    const point = local(event);
    if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, point);
    const drag = gesture.current;
    if (!drag) {
      if (connectionRef.current) updateConnection(point);
      return;
    }
    if (drag.kind === 'pinch') {
      const [a, b] = [...pointers.current.values()];
      if (!a || !b) return;
      const next = zoomAt(drag.view, drag.mid, drag.view.zoom * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, drag.distance));
      setView({
        ...next,
        x: next.x + (a.x + b.x) / 2 - drag.mid.x,
        y: next.y + (a.y + b.y) / 2 - drag.mid.y
      });
      return;
    }
    const dx = point.x - drag.point?.x,
      dy = point.y - drag.point?.y;
    if(drag.kind==='segment'||drag.kind==='endpoint') {
      if(!drag.moved&&Math.hypot(dx,dy)<4)return;
      drag.moved=true;setMoving(true);
      const world=toWorld(point,drag.view);
      if(drag.kind==='endpoint') {
        const node=current.current.byKey.get(drag.end==='source'?drag.edge.a:drag.edge.b);
        updateRoute(drag.edge.key,{...drag.original,[drag.end]:nearestAnchor(node,world)});
      }else {
        const first=drag.edge.points[drag.index-1],last=drag.edge.points[drag.index];
        const coordinate=first.y===last.y ? first.y+dy/drag.view.zoom : first.x+dx/drag.view.zoom;
        updateRoute(drag.edge.key,{...drag.original,via:segmentWaypoints(drag.edge.points,drag.index,coordinate)});
      }
      return;
    }
    if (drag.kind === 'node') {
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      setMoving(true);
      moveNode(drag.key, {
        x: drag.origin.x + dx / drag.view.zoom,
        y: drag.origin.y + dy / drag.view.zoom
      });
    } else if (drag.kind === 'pan') setView({
      ...drag.view,
      x: drag.view.x + dx,
      y: drag.view.y + dy
    });else if (drag.kind === 'connect') {
      if (Math.hypot(dx, dy) > 5) drag.moved = true;
      updateConnection(point);
    }
  }
  function updateConnection(point) {
    const world = toWorld(point, current.current.view),
      active = connectionRef.current;
    if (!active) return;
    const target = current.current.nodes.find(n => n.kind === 'memo' && n.key !== active.source && world.x >= n.x - 20 && world.x <= n.x + W + 20 && world.y >= n.y - 20 && world.y <= n.y + H + 20);
    let targetAnchor = target ? nearestAnchor(target, world) : null;
    const snap = targetAnchor && PORTS.find(p => p.side === targetAnchor.side && Math.abs(p.offset - targetAnchor.offset) < .04);
    if (snap) targetAnchor = {
      ...snap
    };
    const next = {
      ...active,
      point: world,
      target: target?.key || null,
      targetAnchor
    };
    setConnection(next);
    connectionRef.current = next;
  }
  function up(event) {
    const drag = gesture.current;
    pointers.current.delete(event.pointerId);
    if (stage.current.hasPointerCapture(event.pointerId)) stage.current.releasePointerCapture(event.pointerId);
    if (drag?.kind === 'node' && drag.moved) savePosition(current.current.byKey.get(drag.key), current.current.positions[drag.key]);
    if((drag?.kind==='segment'||drag?.kind==='endpoint')&&drag.moved){
      try{saveRoute(drag.edge,routeDraft.current);setError('');}
      catch(e){updateRoute(drag.edge.key,drag.original);setError(e.message);}
    }
    if (drag?.kind === 'connect' && drag.moved) {
      if (connectionRef.current?.target) link(connectionRef.current.source, connectionRef.current.target);else {
        setConnection(null);
        connectionRef.current = null;
      }
    }
    if (drag?.kind === 'pinch' && pointers.current.size === 1) {
      gesture.current = {
        kind: 'pan',
        point: [...pointers.current.values()][0],
        view: current.current.view
      };
      return;
    }
    gesture.current = null;
    setMoving(false);
  }
  function keyDown(event) {
    if (event.key === ' ') {
      event.preventDefault();
      space.current = true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelGesture();
      setSelected(null);
    }
    if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      fit();
    }
    if (event.key === 'Enter' && selectedNode) {
      event.preventDefault();
      open(selectedNode);
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdge) {
      event.preventDefault();
      removeLink();
    }
    if (selectedNode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const distance = event.shiftKey ? 24 : 8;
      const point = {
        x: selectedNode.x + (event.key === 'ArrowRight' ? distance : event.key === 'ArrowLeft' ? -distance : 0),
        y: selectedNode.y + (event.key === 'ArrowDown' ? distance : event.key === 'ArrowUp' ? -distance : 0)
      };
      moveNode(selectedNode.key, point);
      savePosition(selectedNode, bounded(point));
    }
  }
  let preview = [];
  if (connection) {
    const source = byKey.get(connection.source),
      target = byKey.get(connection.target);
    if (source) {
      if (target) preview = routeConnection(source, target, nodes, {
        source: {
          side: connection.side,
          offset: connection.offset
        },
        target: connection.targetAnchor
      });else {
        const start = port(source, connection.side, connection.offset);
        preview = [start, {
          x: connection.point.x,
          y: start.y
        }, connection.point];
      }
    }
  }
  const zoom = factor => setView(previous => zoomAt(previous, {
    x: size.width / 2,
    y: size.height / 2
  }, previous.zoom * factor));
  return <div className={`stella-graph ${view.zoom < .45 ? 'is-far' : ''}`} style={{
    '--graph-title-size': `${Math.max(14, 12 / view.zoom)}px`,
    '--graph-type-size': `${Math.max(11, 10 / view.zoom)}px`,
    '--port-dot-size': `${7 / view.zoom}px`,
    '--border-hit': `${6 / view.zoom}px`
  }}>
    <style>{CSS}</style>
    <header className="graph-heading"><h1>문서 관계</h1><span>{nodes.length}개 기록  /  {scene.edges.length}개 연결</span></header>
    <div className="graph-tools" role="toolbar" aria-label="캔버스 도구">
      <button aria-label="선택 도구" aria-pressed={mode === 'select'} onClick={() => setMode('select')}>↖ 선택</button>
      <button aria-label="화면 이동 도구" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')}>✥ 이동</button>
      <span className="graph-tools-gap" />
      <button aria-label="전체 보기" onClick={fit}>전체 보기</button>
    </div>
    {error && <div className="graph-error" role="alert">{error}<button aria-label="오류 닫기" onClick={() => setError('')}>×</button></div>}
    <div ref={stage} className={`graph-stage ${moving ? 'is-moving' : ''} ${mode === 'pan' ? 'is-pan' : ''} ${connection ? 'is-connecting' : ''}`} tabIndex={0} role="region" aria-label="문서 관계 캔버스" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={() => {
      if (!pointers.current.size) gesture.current = null;
    }} onDoubleClick={event => {
      if (mode === 'pan' || connectionRef.current) return;
      const point = toWorld(local(event), current.current.view);
      const node = current.current.nodes.find(n => point.x >= n.x && point.x <= n.x + W && point.y >= n.y && point.y <= n.y + H);
      if (node) open(node);
    }} onKeyDown={keyDown} onKeyUp={event => {
      if (event.key === ' ') space.current = false;
    }} onBlur={() => {
      space.current = false;
    }} onContextMenu={event => event.preventDefault()}>
      <svg className="graph-grid" aria-hidden="true"><defs><pattern id="stella-graph-grid" width={24 * view.zoom} height={24 * view.zoom} patternUnits="userSpaceOnUse" x={view.x} y={view.y}><circle cx="1" cy="1" r=".7" fill="#343739" /></pattern></defs><rect width="100%" height="100%" fill="url(#stella-graph-grid)" /></svg>
      <div className="graph-world" style={{
        transform: `translate(${view.x}px,${view.y}px) scale(${view.zoom})`
      }}>
        <svg className="graph-lines" aria-label="문서 연결선">
          {routes.map(edge => <g key={edge.key}>
            <path d={pathData(edge.points)} className={`graph-line ${edge.kind === 'hierarchy' ? 'is-hierarchy' : ''} ${selected?.edge === edge.key ? 'is-selected' : ''}`} vectorEffect="non-scaling-stroke" />
            <path d={pathData(edge.points)} className="graph-line-hit" vectorEffect="non-scaling-stroke" data-edge={edge.key} role="button" tabIndex={0} aria-label={`연결: ${byKey.get(edge.a).title} — ${byKey.get(edge.b).title}`} onFocus={() => setSelected({
              edge: edge.key
            })} onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelected({
                  edge: edge.key
                });
              }
            }} />
          </g>)}
          {connection && <path className="graph-preview" d={pathData(preview)} vectorEffect="non-scaling-stroke" />}
          {connection && preview.length > 0 && [preview[0], preview[preview.length - 1]].map((point, i) => <circle key={`preview-${i}`} cx={point.x} cy={point.y} r={3.5 / view.zoom} fill="#c0d8b6" pointerEvents="none" />)}
        </svg>
        <svg className="graph-lines graph-editor-overlay" aria-label="선 조작 핸들">{selectedRoute&&selectedRoute.points.length>0&&[['source',selectedRoute.points[0]],['target',selectedRoute.points.at(-1)]].map(([end,point])=><circle key={end} cx={point.x} cy={point.y} r={6/view.zoom} className="graph-end-handle" data-edge-end={end} data-edge-key={selectedRoute.key} role="button" aria-label={end==='source'?'시작 연결 위치 이동':'끝 연결 위치 이동'}/>)}</svg>
        {nodes.map(node => <div key={node.key} data-node={node.key} className={`graph-node ${selected?.node === node.key ? 'is-selected' : ''} ${connection?.target === node.key ? 'is-target' : ''}`} style={{
          left: node.x,
          top: node.y,
          width: W,
          height: H
        }}>
          <button className="graph-node-body" aria-label={`${typeName(node.kind)}: ${node.title}`} onFocus={() => setSelected({
            node: node.key
          })} onClick={event => {
            if (event.detail === 0 && connectionRef.current) {
              link(connectionRef.current.source, node.key);
              return;
            }
            if (!moving) setSelected({
              node: node.key
            });
          }} onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              if (connectionRef.current) link(connectionRef.current.source, node.key);else open(node);
            }
          }}>
            <span className="graph-node-title">{node.title}</span><span className="graph-node-type">{typeName(node.kind)}</span>
          </button>
          {node.kind === 'memo' && ['left', 'right', 'top', 'bottom'].map(side => <span key={`border-${side}`} data-border={side} className={`graph-connect-border border-${side}`} aria-hidden="true" />)}
          {node.kind === 'memo' && PORTS.map(({
            side,
            offset
          }) => <button key={`${side}:${offset}`} data-port={side} data-offset={offset} className={`graph-port port-${side}`} style={side === 'left' || side === 'right' ? {
            top: `${offset * 100}%`
          } : {
            left: `${offset * 100}%`
          }} aria-label={`${node.title}: ${sideName[side]} 연결점 ${offset * 4}`} onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              const next = {
                source: node.key,
                side,
                offset,
                point: port(node, side, offset),
                target: null
              };
              setConnection(next);
              connectionRef.current = next;
            }
          }}><span /></button>)}
        </div>)}
      </div>
      {!nodes.length && <div className="graph-empty">문서를 작성하면 여기에 나타납니다.</div>}
      {selectedRoute&&!connection&&<div className="graph-edit-hint">선을 끌어 구간 이동  /  양 끝 원을 끌어 연결 위치 변경{selectedRoute.anchors.via?.length>0&&<button onPointerDown={e=>e.stopPropagation()} onClick={resetRoute}>꺾임 초기화</button>}</div>}
    </div>
    <div className="graph-context" aria-live="polite">
      {connection ? <><span>연결할 문서의 테두리로 끌어주세요</span><button onClick={() => {
          setConnection(null);
          connectionRef.current = null;
        }}>취소</button></> : selectedNode ? <><span className="graph-selected-title">{selectedNode.title}</span><button onClick={() => open(selectedNode)}>열기 ↗</button></> : selectedEdge ? <><span>{selectedEdge.kind === 'manual' ? '문서 연결' : selectedEdge.kind === 'hierarchy' ? '상위 / 하위 문서' : selectedEdge.kind === 'source' ? '원본 / 요약 문서' : '문서 / 할 일 연결'}</span>{selectedEdge.kind === 'manual' ? <button className="graph-delete" onClick={removeLink}>연결 해제</button> : <span className="graph-muted">문서 편집에서 관리</span>}</> : <span className="graph-muted">테두리 어디서나 연결  /  본문 드래그로 이동</span>}
      <div className="graph-zoom"><button aria-label="축소" onClick={() => zoom(1 / 1.2)}>−</button><button aria-label="100% 보기" onClick={() => setView(previous => zoomAt(previous, {
          x: size.width / 2,
          y: size.height / 2
        }, 1))}>{Math.round(view.zoom * 100)}%</button><button aria-label="확대" onClick={() => zoom(1.2)}>+</button></div>
    </div>
  </div>;
}
const CSS = `
.stella-graph{display:flex;flex:1;flex-direction:column;min-height:0;width:100%;color:#f0f0ee;font-family:inherit;background:#191a1b}
.stella-graph *{box-sizing:border-box}.stella-graph button{font:inherit;color:inherit;cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent}
.stella-graph button:focus-visible{outline:2px solid #bfd4b8;outline-offset:2px}
.graph-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:18px 18px 12px}
.graph-heading h1{font-size:22px;line-height:28px;letter-spacing:-.6px;margin:0;font-weight:600}.graph-heading>span{font-size:12px;color:#a9adae;white-space:nowrap}
.graph-tools{display:flex;align-items:center;gap:4px;padding:0 12px 10px}.graph-tools button,.graph-context button{background:transparent;border:1px solid transparent;border-radius:4px;min-height:36px;padding:6px 10px;font-size:12px;white-space:nowrap}
.graph-tools button[aria-pressed=true]{background:#303234;border-color:#4c5151}.graph-tools button:hover,.graph-context button:hover{background:#303234}.graph-tools-gap{flex:1}
.graph-stage{position:relative;flex:1;min-height:300px;overflow:hidden;background:#17191a;border-block:1px solid #2d3032;touch-action:none;user-select:none;outline:none;cursor:default}
.graph-stage.is-pan{cursor:grab}.graph-stage.is-moving,.graph-stage.is-moving *{cursor:grabbing!important}.graph-stage.is-connecting{cursor:crosshair}
.graph-grid{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.graph-world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}
.graph-lines{position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none}
.graph-line{fill:none;stroke:#929d96;stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round;pointer-events:none}.graph-line.is-hierarchy{stroke:#7e8985}.graph-line.is-selected{stroke:#d4e6cc;stroke-width:2.5}
.graph-line-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:pointer}.graph-line-hit:focus{outline:none;stroke:#b8cbb333;stroke-width:12}
.graph-preview{fill:none;stroke:#c0d8b6;stroke-width:2;stroke-dasharray:6 4;pointer-events:none}
.graph-node{position:absolute;background:#242729;border:1px solid #3d4540;border-radius:4px}.graph-node:hover{border-color:#9ca99e}.graph-node.is-selected{border:2px solid #c4d8b9}.graph-node.is-target{border-color:#c4d8b9;background:#303a32}
.graph-node-body{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;width:100%;height:100%;padding:11px 17px;background:transparent;border:0;text-align:left;border-radius:4px;cursor:grab!important}
.graph-node-title{width:100%;flex-shrink:0;font-size:var(--graph-title-size);font-weight:500;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:keep-all;overflow-wrap:anywhere}.graph-node-type{flex-shrink:0;font-size:var(--graph-type-size);color:#aeb6b0;margin-top:5px;line-height:1.25}.is-far .graph-node-type{display:none}.is-far .graph-node-title{-webkit-line-clamp:1}
.graph-editor-overlay{z-index:3}.graph-end-handle{fill:#191a1b;stroke:#d4e6cc;stroke-width:1.5;vector-effect:non-scaling-stroke;pointer-events:all;cursor:crosshair}
.graph-edit-hint{position:absolute;bottom:12px;left:12px;right:12px;pointer-events:none;background:#222325;padding:9px 12px;border:1px solid #2d3032;border-radius:4px;font-size:12px;line-height:19px;color:#c8ccca}.graph-edit-hint button{pointer-events:auto;display:block;background:transparent;border:0;color:#f0f0ee;padding:6px 0;font-size:12px}
.graph-connect-border{position:absolute;z-index:1;cursor:crosshair}.border-left{left:-2px;top:0;bottom:0;width:var(--border-hit)}.border-right{right:-2px;top:0;bottom:0;width:var(--border-hit)}.border-top{top:-2px;left:0;right:0;height:var(--border-hit)}.border-bottom{bottom:-2px;left:0;right:0;height:var(--border-hit)}
.graph-port{position:absolute;z-index:2;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;background:transparent;opacity:0;cursor:crosshair!important}.graph-port span{display:block;width:var(--port-dot-size);height:var(--port-dot-size);background:#17191a;border:1px solid #c2d6b8;border-radius:50%;pointer-events:none}
.graph-node:hover .graph-port,.graph-node.is-selected .graph-port,.is-connecting .graph-port,.graph-port:focus-visible{opacity:1}.port-left{left:-13px;height:16px;transform:translateY(-50%)}.port-right{right:-13px;height:16px;transform:translateY(-50%)}.port-top{top:-13px;width:16px;transform:translateX(-50%)}.port-bottom{bottom:-13px;width:16px;transform:translateX(-50%)}
.graph-context{display:flex;align-items:center;gap:6px;min-height:54px;padding:6px 10px;font-size:12px}.graph-context>span{flex:1;min-width:0;line-height:17px}.graph-selected-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}.graph-muted{color:#a9adae;font-size:11px}.graph-context>.graph-muted{max-width:220px}.graph-zoom{margin-left:auto;display:flex;flex-shrink:0;align-items:center;border:1px solid #3d4142;border-radius:4px}.graph-zoom button{padding:4px 7px;min-width:32px;min-height:36px}.graph-zoom button:nth-child(2){font-size:11px;min-width:42px}.graph-delete{color:#f0abab!important}
.graph-error{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#f0abab;padding:8px 16px;line-height:18px}.graph-error button{background:transparent;border:0;min-height:32px;min-width:32px}.graph-empty{position:absolute;top:40%;width:100%;text-align:center;font-size:14px;color:#a9adae;pointer-events:none}
@media(pointer:coarse){.graph-port{opacity:1}}
`;
