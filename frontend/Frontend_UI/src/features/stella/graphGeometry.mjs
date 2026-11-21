// All positions are world coordinates. Only the viewport maps world to screen.
export const NODE_WIDTH = 212;
export const NODE_HEIGHT = 128;
export const SIDES = ['left', 'right', 'top', 'bottom'];
export const PORTS = SIDES.flatMap(side => [.25, .5, .75].map(offset => ({
  side,
  offset
})));
export const clampZoom = zoom => Math.max(.25, Math.min(2, zoom));
export const toWorld = (point, view) => ({
  x: (point.x - view.x) / view.zoom,
  y: (point.y - view.y) / view.zoom
});
export function zoomAt(view, point, zoom) {
  const world = toWorld(point, view);
  const next = clampZoom(zoom);
  return {
    x: point.x - world.x * next,
    y: point.y - world.y * next,
    zoom: next
  };
}
export function fitView(rectangles, size, padding = 36) {
  if (!rectangles.length) return {
    x: 24,
    y: 24,
    zoom: 1
  };
  const left = Math.min(...rectangles.map(r => r.x));
  const top = Math.min(...rectangles.map(r => r.y));
  const right = Math.max(...rectangles.map(r => r.x + r.width));
  const bottom = Math.max(...rectangles.map(r => r.y + r.height));
  const zoom = Math.min(1, clampZoom(Math.min((size.width - padding * 2) / (right - left), (size.height - padding * 2) / (bottom - top))));
  return {
    x: (size.width - (right - left) * zoom) / 2 - left * zoom,
    y: (size.height - (bottom - top) * zoom) / 2 - top * zoom,
    zoom
  };
}
export function port(rect, side, offset = .5) {
  if (side === 'left') return {
    x: rect.x,
    y: rect.y + rect.height * offset
  };
  if (side === 'right') return {
    x: rect.x + rect.width,
    y: rect.y + rect.height * offset
  };
  if (side === 'top') return {
    x: rect.x + rect.width * offset,
    y: rect.y
  };
  return {
    x: rect.x + rect.width * offset,
    y: rect.y + rect.height
  };
}
export function nearestAnchor(rect, point) {
  const distances = [['left', Math.abs(point.x - rect.x)], ['right', Math.abs(point.x - rect.x - rect.width)], ['top', Math.abs(point.y - rect.y)], ['bottom', Math.abs(point.y - rect.y - rect.height)]];
  distances.sort((a, b) => a[1] - b[1]);
  const side = distances[0][0];
  const offset = side === 'left' || side === 'right' ? (point.y - rect.y) / rect.height : (point.x - rect.x) / rect.width;
  return {
    side,
    offset: Math.max(.02, Math.min(.98, offset))
  };
}
export function sharedLength(a, b, c, d) {
  if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < .01) return Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)));
  if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < .01) return Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
  return 0;
}
function lanePenalty(a, b, reserved) {
  let cost = 0;
  for (const [c, d] of reserved) {
    if (sharedLength(a, b, c, d) > 0) cost += 100000;else if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < 12 && Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) > Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))) cost += 5000;else if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < 12 && Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) > Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))) cost += 5000;
  }
  return cost;
}
const direction = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1]
};
const inside = (p, r) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
export function segmentBlocked(a, b, rectangles) {
  return rectangles.some(r => {
    if (a.x === b.x) return a.x > r.x && a.x < r.x + r.width && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.height;
    return a.y > r.y && a.y < r.y + r.height && Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.width;
  });
}
function simplify(points) {
  return points.filter((p, i) => {
    if (i && p.x === points[i - 1].x && p.y === points[i - 1].y) return false;
    if (!i || i === points.length - 1) return true;
    const a = points[i - 1],
      b = points[i + 1];
    return !(a.x === p.x && p.x === b.x || a.y === p.y && p.y === b.y);
  });
}
export function pathData(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
}
// Orthogonal visibility grid. Bend cost avoids the staircase routes of plain shortest paths.
function orthogonalRoute(start, end, obstacles, reserved = []) {
  const xs = [...new Set([start.x, end.x, ...obstacles.flatMap(r => [r.x, r.x + r.width]), ...reserved.flatMap(([a, b]) => [a.x - 16, a.x + 16, b.x - 16, b.x + 16])])].sort((a, b) => a - b);
  const ys = [...new Set([start.y, end.y, ...obstacles.flatMap(r => [r.y, r.y + r.height]), ...reserved.flatMap(([a, b]) => [a.y - 16, a.y + 16, b.y - 16, b.y + 16])])].sort((a, b) => a - b);
  const points = [],
    grid = new Map();
  for (let y = 0; y < ys.length; y++) for (let x = 0; x < xs.length; x++) {
    const p = {
      x: xs[x],
      y: ys[y]
    };
    if (!obstacles.some(r => inside(p, r))) {
      grid.set(`${x}:${y}`, points.length);
      points.push({
        ...p,
        gx: x,
        gy: y
      });
    }
  }
  const begin = points.findIndex(p => p.x === start.x && p.y === start.y);
  const goal = points.findIndex(p => p.x === end.x && p.y === end.y);
  if (begin < 0 || goal < 0) return null;
  const neighbors = points.map(p => {
    const result = [];
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const target = grid.get(`${p.gx + dx}:${p.gy + dy}`);
      if (target != null && !segmentBlocked(p, points[target], obstacles)) result.push([target, dx ? 0 : 1]);
    }
    return result;
  });
  // A small binary heap keeps routing responsive when several documents are visible.
  const heap = [],
    distances = new Map(),
    previous = new Map();
  function push(item) {
    let i = heap.length;
    heap.push(item);
    while (i) {
      const parent = i - 1 >> 1;
      if (heap[parent][0] <= item[0]) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  }
  function pop() {
    const first = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
        if (heap[child][0] >= last[0]) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  }
  for (const axis of [0, 1]) {
    const key = begin * 2 + axis;
    distances.set(key, 0);
    push([0, key]);
  }
  let finish;
  while (heap.length) {
    const [cost, key] = pop();
    if (cost !== distances.get(key)) continue;
    const index = Math.floor(key / 2),
      axis = key % 2;
    if (index === goal) {
      finish = key;
      break;
    }
    for (const [next, nextAxis] of neighbors[index]) {
      const nextKey = next * 2 + nextAxis;
      const nextCost = cost + Math.abs(points[index].x - points[next].x) + Math.abs(points[index].y - points[next].y) + (axis === nextAxis ? 0 : 24) + lanePenalty(points[index], points[next], reserved);
      if (nextCost < (distances.get(nextKey) ?? Infinity)) {
        distances.set(nextKey, nextCost);
        previous.set(nextKey, key);
        push([nextCost, nextKey]);
      }
    }
  }
  if (finish == null) return null;
  const route = [];
  for (let key = finish; key != null; key = previous.get(key)) route.unshift(points[Math.floor(key / 2)]);
  return simplify(route);
}
export function automaticAnchors(a, b) {
  const horizontalGap = Math.max(b.x - a.x - a.width, a.x - b.x - b.width),
    verticalGap = Math.max(b.y - a.y - a.height, a.y - b.y - b.height);
  const sides = horizontalGap >= 0 && horizontalGap >= verticalGap ? a.x < b.x ? ['right', 'left'] : ['left', 'right'] : a.y < b.y ? ['bottom', 'top'] : ['top', 'bottom'];
  return {
    source: {
      side: sides[0],
      offset: .5
    },
    target: {
      side: sides[1],
      offset: .5
    }
  };
}
export function routeConnection(a, b, rectangles = [], preferredSide, reserved = []) {
  if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) return [];
  const horizontalGap = Math.max(b.x - a.x - a.width, a.x - b.x - b.width);
  const verticalGap = Math.max(b.y - a.y - a.height, a.y - b.y - b.height);
  const anchors = preferredSide && typeof preferredSide === 'object' ? preferredSide : automaticAnchors(a, b);
  if (typeof preferredSide === 'string') anchors.source.side = preferredSide;
  const sides = [anchors.source.side, anchors.target.side];
  const start = port(a, sides[0], anchors.source.offset),
    end = port(b, sides[1], anchors.target.offset);
  const gap = sides[0] === 'left' || sides[0] === 'right' ? horizontalGap : verticalGap;
  const clearance = Math.max(0, Math.min(12, gap / 4));
  const stub = Math.max(1, Math.min(24, gap / 2));
  const obstacles = rectangles.map(r => ({
    x: r.x - clearance,
    y: r.y - clearance,
    width: r.width + clearance * 2,
    height: r.height + clearance * 2
  }));
  // Aligned nodes stay straight, including unequal centers with overlapping sides.
  if (!anchors.via?.length && (start.x === end.x || start.y === end.y) && !segmentBlocked(start, end, rectangles) && !lanePenalty(start, end, reserved)) return [start, end];
  const from = {
    x: start.x + direction[sides[0]][0] * stub,
    y: start.y + direction[sides[0]][1] * stub
  };
  const to = {
    x: end.x + direction[sides[1]][0] * stub,
    y: end.y + direction[sides[1]][1] * stub
  };
  const checkpoints=[from,...(anchors.via || []),to];
  let middle=[];
  for(let i=1;i<checkpoints.length;i++) {
    const section=orthogonalRoute(checkpoints[i-1],checkpoints[i],obstacles,reserved);
    if(!section){middle=null;break;}
    middle.push(...(i===1?section:section.slice(1)));
  }
  // Never render a misleading line through a node when no clear corridor exists.
  return middle ? simplify([start, ...middle, end]) : [];
}
export function segmentWaypoints(points,index,coordinate) {
  const a=points[index-1],b=points[index];
  if(!a||!b)throw new Error('조작할 선 구간이 없습니다');
  const horizontal=a.y===b.y;
  const start={...a},end={...b};
  if(index===1){if(horizontal)start.x+=Math.sign(b.x-a.x)*24;else start.y+=Math.sign(b.y-a.y)*24;}
  if(index===points.length-1){if(horizontal)end.x-=Math.sign(b.x-a.x)*24;else end.y-=Math.sign(b.y-a.y)*24;}
  if(horizontal){start.y=coordinate;end.y=coordinate;}else{start.x=coordinate;end.x=coordinate;}
  return simplify([...points.slice(1,index-1),start,end,...points.slice(index+1,-1)]).map(p=>({x:p.x,y:p.y}));
}
export function routeGraphConnections(nodes, edges) {
  const lookup = new Map(nodes.map(n => [n.key, n]));
  const prepared = edges.map(edge => ({
    ...edge,
    anchors: edge.anchors || automaticAnchors(lookup.get(edge.a), lookup.get(edge.b))
  }));
  const groups = new Map();
  const fixed = new Map();
  for (const edge of prepared.filter(e => edges.find(original => original.key === e.key)?.anchors)) for (const [end, key] of [['source', edge.a], ['target', edge.b]]) {
    const groupKey = `${key}:${edge.anchors[end].side}`;
    if (!fixed.has(groupKey)) fixed.set(groupKey, []);
    fixed.get(groupKey).push(edge.anchors[end].offset);
  }
  for (const edge of prepared) for (const [end, key, other] of [['source', edge.a, edge.b], ['target', edge.b, edge.a]]) {
    if (edges.find(e => e.key === edge.key)?.anchors) continue;
    const groupKey = `${key}:${edge.anchors[end].side}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    const node = lookup.get(other),
      side = edge.anchors[end].side;
    groups.get(groupKey).push({
      edge,
      end,
      order: side === 'left' || side === 'right' ? node.y + node.height / 2 : node.x + node.width / 2
    });
  }
  for (const [groupKey, group] of groups) {
    group.sort((a, b) => a.order - b.order || a.edge.key.localeCompare(b.edge.key));
    const occupied = fixed.get(groupKey) || [];
    const candidates = occupied.length ? [] : group.map((_,i)=>(i+1)/(group.length+1));
    const slots=[0,...occupied,1];
    for(let i=candidates.length;i<group.length;i++) {
      slots.sort((a,b)=>a-b);
      let widest=0;
      for(let j=1;j<slots.length-1;j++)if(slots[j+1]-slots[j]>slots[widest+1]-slots[widest])widest=j;
      const offset=(slots[widest]+slots[widest+1])/2;
      slots.push(offset);candidates.push(offset);
    }
    candidates.sort((a,b)=>a-b);
    group.forEach((item, i) => {
      item.edge.anchors[item.end].offset = candidates[i];
    });
  }
  const reserved = [];
  return prepared.map(edge => {
    const points = routeConnection(lookup.get(edge.a), lookup.get(edge.b), nodes, edge.anchors, reserved);
    for (let i = 1; i < points.length; i++) reserved.push([points[i - 1], points[i]]);
    return {
      ...edge,
      points
    };
  });
}
