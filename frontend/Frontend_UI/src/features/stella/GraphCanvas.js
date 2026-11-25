import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, Pressable, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useValue, runtime, readPreference, writePreference } from '../../data/hooks';
import { useTasks } from '../../data/tasks/TaskStore';
import Icon from '../../shared/components/Icon';
import { ROUTES } from '../../navigation/routes';
import { palette as c, styles as s } from './theme';
import { connectorPath } from './model.mjs';
import { useInsets } from '../../shared/hooks/useInsets';
const WIDTH = 190,
  HEIGHT = 72;
function GraphNode({
  node,
  position,
  offset,
  zoom,
  onMove,
  onCommit,
  onOpen
}) {
  const start = useRef(position),
    latest = useRef({
      position,
      zoom,
      onMove,
      onCommit
    });
  const dragged = useRef(false);
  const pointer = useRef(null);
  const openedOnPointer = useRef(false);
  latest.current = {
    position,
    zoom,
    onMove,
    onCommit
  };
  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 5,
    onPanResponderGrant: () => {
      start.current = latest.current.position;
      dragged.current = true;
    },
    onPanResponderMove: (_, gesture) => latest.current.onMove({
      x: start.current.x + gesture.dx / latest.current.zoom,
      y: start.current.y + gesture.dy / latest.current.zoom
    }),
    onPanResponderRelease: () => {
      latest.current.onCommit();
      setTimeout(() => {
        dragged.current = false;
      }, 100);
    },
    onPanResponderTerminate: () => {
      latest.current.onCommit();
      dragged.current = false;
    }
  }), []);
  const webDrag = {
    onPointerDown(event) {
      event.stopPropagation();
      const e = event.nativeEvent;
      dragged.current = false;
      openedOnPointer.current = false;
      pointer.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        position: latest.current.position
      };
      event.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(event) {
      const drag = pointer.current,
        e = event.nativeEvent;
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x,
        dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) < 5 && !dragged.current) return;
      dragged.current = true;
      latest.current.onMove({
        x: drag.position.x + dx / latest.current.zoom,
        y: drag.position.y + dy / latest.current.zoom
      });
    },
    onPointerUp(event) {
      if (!pointer.current) return;
      pointer.current = null;
      event.stopPropagation();
      if (dragged.current) latest.current.onCommit();else {
        openedOnPointer.current = true;
        onOpen();
      }
    },
    onPointerCancel() {
      if (pointer.current && dragged.current) latest.current.onCommit();
      pointer.current = null;
    }
  };
  return <View {...Platform.OS === 'web' ? webDrag : responder.panHandlers} style={{
    position: 'absolute',
    left: position.x - offset.x,
    top: position.y - offset.y,
    width: WIDTH,
    minHeight: HEIGHT,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: node.kind === 'memo' ? '#6a6e72' : '#45494c',
    borderRadius: 4,
    touchAction: 'none'
  }}><Pressable accessibilityRole="button" accessibilityLabel={`${node.kind === 'memo' ? '문서' : '할 일 / 일정'}: ${node.title}`} onPress={() => {
      if (!dragged.current && !openedOnPointer.current) onOpen();
    }} style={{
      paddingHorizontal: 13,
      paddingVertical: 11,
      minHeight: HEIGHT
    }}><Text style={s.rowTitle} numberOfLines={1}>{node.title}</Text><Text style={s.meta}>{node.kind === 'memo' ? '문서' : node.kind === 'event' ? '일정' : '할 일'}</Text></Pressable></View>;
}
export default function GraphCanvas({
  navigation
}) {
  const own = runtime();
  const insets = useInsets();
  const documents = useValue(() => own.documents.listDocuments());
  const tasks = useTasks();
  const taskPositionKey = `stella-graph-tasks:${own.store.getCurrentWorkspace().id}`;
  const [overrides, setOverrides] = useState(() => readPreference(taskPositionKey, {}));
  const [view, setView] = useState({
    x: 18,
    y: 24,
    zoom: .75
  });
  const [error, setError] = useState('');
  const viewRef = useRef(view);
  viewRef.current = view;
  const positionsRef = useRef({});
  const start = useRef(view);
  const panPointer = useRef(null);
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) + Math.abs(gesture.dy) > 5,
    onPanResponderGrant: () => {
      start.current = viewRef.current;
    },
    onPanResponderMove: (_, gesture) => setView({
      ...start.current,
      x: start.current.x + gesture.dx,
      y: start.current.y + gesture.dy
    })
  }), []);
  const webPan = {
    onPointerDown(event) {
      const e = event.nativeEvent;
      panPointer.current = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        view: viewRef.current
      };
      event.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove(event) {
      const drag = panPointer.current,
        e = event.nativeEvent;
      if (drag && drag.id === e.pointerId) setView({
        ...drag.view,
        x: drag.view.x + e.clientX - drag.x,
        y: drag.view.y + e.clientY - drag.y
      });
    },
    onPointerUp() {
      panPointer.current = null;
    },
    onPointerCancel() {
      panPointer.current = null;
    }
  };
  const nodes = documents.map((document, index) => ({
    key: `m:${document.id}`,
    id: document.id,
    kind: 'memo',
    title: document.title || document.body.slice(0, 35) || '제목 없는 문서',
    x: document.x ?? 35 + index % 2 * 250,
    y: document.y ?? 35 + Math.floor(index / 2) * 150
  }));
  const edges = [];
  for (const document of documents) {
    if (document.parentId) edges.push([`m:${document.parentId}`, `m:${document.id}`]);
    for (const taskId of document.taskIds) {
      const task = tasks.find(item => item.id === taskId);
      if (!task) continue;
      if (!nodes.some(node => node.key === `t:${taskId}`)) nodes.push({
        key: `t:${taskId}`,
        id: taskId,
        kind: task.kind,
        title: task.title,
        x: 285 + nodes.length % 2 * 30,
        y: 220 + nodes.length * 85
      });
      edges.push([`m:${document.id}`, `t:${taskId}`]);
    }
  }
  for (const link of own.documents.links()) edges.push([`m:${link.source}`, `m:${link.target}`]);
  const positions = Object.fromEntries(nodes.map(node => [node.key, overrides[node.key] || {
    x: node.x,
    y: node.y
  }]));
  positionsRef.current = positions;
  const coordinates = Object.values(positions);
  const minX = Math.min(0, ...coordinates.map(point => point.x)) - 60,
    minY = Math.min(0, ...coordinates.map(point => point.y)) - 60;
  const worldWidth = Math.max(500, ...coordinates.map(point => point.x + WIDTH)) - minX + 60,
    worldHeight = Math.max(500, ...coordinates.map(point => point.y + HEIGHT)) - minY + 60;
  const byKey = new Map(nodes.map(node => [node.key, node]));
  const uniqueEdges = [...new Map(edges.filter(([a, b]) => byKey.has(a) && byKey.has(b)).map(edge => [[...edge].sort().join('|'), edge])).values()];
  function commit(node) {
    const position = positionsRef.current[node.key];
    try {
      if (node.kind === 'memo') own.documents.savePosition(node.id, position.x, position.y);else writePreference(taskPositionKey, Object.fromEntries(Object.entries(positionsRef.current).filter(([key]) => key.startsWith('t:'))));
      setError('');
    } catch (e) {
      setError(e.message);
      setOverrides(previous => {
        const next = {
          ...previous
        };
        delete next[node.key];
        return next;
      });
    }
  }
  function changeZoom(delta) {
    setView(previous => ({
      ...previous,
      zoom: Math.min(1.8, Math.max(.35, Math.round((previous.zoom + delta) * 100) / 100))
    }));
  }
  return <View style={{
    flex: 1
  }}><View style={{
      paddingHorizontal: 22,
      paddingTop: 25,
      paddingBottom: 16
    }}><Text style={[s.intro, { marginTop: 0 }]}>문서를 연결하고, 생각의 흐름을 살펴보세요.</Text></View>{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}<View {...Platform.OS === 'web' ? webPan : pan.panHandlers} accessibilityLabel="문서 관계 캔버스  /  빈 공간을 드래그해 이동" style={{
      flex: 1,
      minHeight: 320,
      overflow: 'hidden',
      backgroundColor: '#17191a',
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: c.line,
      touchAction: 'none'
    }}><View pointerEvents="none" style={{
        position: 'absolute',
        inset: 0
      }}>{Array.from({
          length: 16
        }, (_, index) => <View key={index} style={{
          position: 'absolute',
          left: index * 28,
          top: 0,
          bottom: 0,
          width: 1,
          backgroundColor: '#1d2021'
        }} />)}</View><View style={{
        position: 'absolute',
        left: view.x + minX * view.zoom,
        top: view.y + minY * view.zoom,
        width: worldWidth,
        height: worldHeight,
        transform: [{
          scale: view.zoom
        }],
        transformOrigin: 'top left'
      }}><Svg pointerEvents="none" width={worldWidth} height={worldHeight} viewBox={`${minX} ${minY} ${worldWidth} ${worldHeight}`} style={{
          position: 'absolute',
          left: 0,
          top: 0
        }}>{uniqueEdges.map(([a, b]) => <Path key={`${a}:${b}`} d={connectorPath({
            ...positions[a],
            width: WIDTH,
            height: HEIGHT
          }, {
            ...positions[b],
            width: WIDTH,
            height: HEIGHT
          })} fill="none" stroke="#78847c" strokeWidth={1.5} />)}</Svg>{nodes.map(node => <GraphNode key={node.key} node={node} position={positions[node.key]} offset={{
          x: minX,
          y: minY
        }} zoom={view.zoom} onMove={position => {
          positionsRef.current[node.key] = position;
          setOverrides(previous => ({
            ...previous,
            [node.key]: position
          }));
        }} onCommit={() => commit(node)} onOpen={() => navigation.navigate(node.kind === 'memo' ? ROUTES.MemoEdit : ROUTES.TaskEdit, node.kind === 'memo' ? {
          memoId: node.id
        } : {
          taskId: node.id
        })} />)}</View>{!nodes.length && <View pointerEvents="none" style={{
        padding: 25
      }}><Text style={s.empty}>문서를 작성하면 여기에 나타납니다.</Text></View>}<View onPointerDown={Platform.OS === 'web' ? event => event.stopPropagation() : undefined} style={{
        position: 'absolute',
        bottom: 15 + insets.bottom,
        right: 15,
        flexDirection: 'row',
        backgroundColor: c.surface,
        borderWidth: 1,
        borderColor: c.line,
        borderRadius: 4
      }}>{[['축소', 'minus', () => changeZoom(-.1)], ['보기 초기화', 'target', () => setView({
          x: 18,
          y: 24,
          zoom: .75
        })], ['확대', 'plus', () => changeZoom(.1)]].map(([label, icon, onPress]) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={s.iconButton}>{label === '보기 초기화' ? <Text style={s.meta}>{Math.round(view.zoom * 100)}%</Text> : <Icon name={icon} size={18} color={c.text} />}</Pressable>)}</View></View><View style={{
      padding: 15,
      paddingBottom: 15 + insets.bottom
    }}><Text style={s.note}>빈 공간은 화면 이동  /  문서는 위치 이동  /  누르면 열기</Text></View></View>;
}
