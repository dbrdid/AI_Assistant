import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TABLE_VIEW, parsePropertyValue, projectTableRows, removeProjectProperty } from '../../frontend/Frontend_UI/src/features/project/components/projectTableView.mjs';
import { exportProjectTablePreferences, prepareProjectTablePreferences, projectTableKey, projectViewKey } from '../../frontend/Frontend_UI/src/data/projects/projectTablePreferences.mjs';

test('a saved project view applies its filters and sort to fresh records', () => {
  const sections = [
    { key: 'memos', label: '메모', items: [{ id: 'm1', title: '작업 1' }] },
    { key: 'todos', label: '할 일', items: [
      { id: 't1', title: '작업 2', status: '진행 중', date: '2026-11-20' },
      { id: 't2', title: '작업 12', status: '완료', date: '2026-11-21' },
      { id: 't3', title: '작업 10', status: '진행 중', date: '2026-11-24' },
    ] },
  ];
  const saved = JSON.parse(JSON.stringify({ ...DEFAULT_TABLE_VIEW, type: 'todos', status: '진행 중', sortKey: 'date', descending: true }));
  assert.deepEqual(projectTableRows(sections, saved).map(row => row.id), ['t3', 't1']);
  assert.deepEqual(projectTableRows(sections, { ...DEFAULT_TABLE_VIEW, sortKey: 'date', descending: true }).map(row => row.id), ['t3', 't2', 't1', 'm1']);
  sections[1].items[0].status = '완료';
  assert.deepEqual(projectTableRows(sections, saved).map(row => row.id), ['t3']);
});

test('project table backups preserve typed cells and reject invalid or foreign project settings', () => {
  const projects = [{ id: 'alpha' }, { id: 'beta' }];
  const field = { key: 'property:review', label: '검토', type: 'checkbox' };
  const view = { ...DEFAULT_TABLE_VIEW, sortKey: field.key, propertyFilter: { key: field.key, value: false } };
  const table = { fields: [field], properties: { 'memos:a': { [field.key]: false } }, view, saved: [{ name: '검토', view }] };
  const original = new Map([[projectViewKey('alpha'), 'table'], [projectTableKey('alpha'), table], [projectViewKey('beta'), 'board']]);
  const snapshot = JSON.parse(JSON.stringify(exportProjectTablePreferences(projects, (key, fallback) => original.get(key) ?? fallback)));
  const restored = new Map(prepareProjectTablePreferences(projects, snapshot));
  assert.deepEqual(restored.get(projectTableKey('alpha')), table);
  assert.equal(restored.get(projectViewKey('alpha')), 'table');
  assert.equal(restored.get(projectTableKey('beta')), null);
  assert.equal(restored.get(projectViewKey('beta')), 'board');
  assert.deepEqual(prepareProjectTablePreferences(projects, undefined), []);
  assert.throws(() => prepareProjectTablePreferences(projects, [{ ...snapshot[0], id: 'outside' }]), TypeError);
  snapshot[0].table.properties['memos:a'][field.key] = 'false';
  assert.throws(() => prepareProjectTablePreferences(projects, snapshot), TypeError);
});

test('removing a custom property cleans its values and sort references without affecting other fields', () => {
  const cost = { key: 'property:cost', label: '예산', type: 'number' };
  const flag = { key: 'property:flag', label: '검토', type: 'checkbox' };
  const sortedByCost = { ...DEFAULT_TABLE_VIEW, type: 'todos', sortKey: cost.key, descending: true, propertyFilter: { key: cost.key, value: 0 } };
  const sortedByFlag = { ...DEFAULT_TABLE_VIEW, sortKey: flag.key };
  const settings = {
    fields: [cost, flag],
    properties: { 'tasks:1': { [cost.key]: 5, [flag.key]: false }, 'tasks:2': { [cost.key]: 0 } },
    view: sortedByCost,
    saved: [{ name: '비용순', view: sortedByCost }, { name: '검토순', view: sortedByFlag }],
  };
  const result = removeProjectProperty(settings, cost.key);
  const reset = { ...DEFAULT_TABLE_VIEW, type: 'todos' };
  assert.deepEqual(result.fields, [flag]);
  assert.deepEqual(result.properties, { 'tasks:1': { [flag.key]: false } });
  assert.deepEqual(result.view, reset);
  assert.deepEqual(result.saved, [{ name: '비용순', view: reset }, { name: '검토순', view: sortedByFlag }]);
  assert.equal(settings.properties['tasks:2'][cost.key], 0);
});

test('custom columns retain zero and false and sort numeric values before empty cells', () => {
  assert.equal(parsePropertyValue('number', ' 0 '), 0);
  assert.equal(parsePropertyValue('number', '-2.5'), -2.5);
  assert.equal(parsePropertyValue('number', '1e+21'), 1e21);
  assert.equal(parsePropertyValue('number', '1e900'), undefined);
  assert.equal(parsePropertyValue('number', '5만원'), undefined);
  assert.equal(parsePropertyValue('checkbox', 'false'), false);
  assert.equal(parsePropertyValue('checkbox', ''), null);
  const sections = [{ key: 'todos', kind: 'tasks', label: '할 일', items: [
    { id: 'empty' }, { id: 'low' }, { id: 'high' }, { id: 'zero' },
  ] }];
  const settings = JSON.parse(JSON.stringify({
    'tasks:low': { 'property:비용': -2.5 },
    'tasks:high': { 'property:비용': 10 },
    'tasks:zero': { 'property:비용': 0 },
  }));
  const view = { ...DEFAULT_TABLE_VIEW, sortKey: 'property:비용' };
  assert.deepEqual(projectTableRows(sections, view, settings).map(row => row.id), ['low', 'zero', 'high', 'empty']);
  assert.deepEqual(projectTableRows(sections, { ...view, descending: true }, settings).map(row => row.id), ['high', 'zero', 'low', 'empty']);
  const filtered = { ...view, propertyFilter: { key: 'property:비용', value: 0 } };
  assert.deepEqual(projectTableRows(sections, filtered, settings).map(row => row.id), ['zero', 'high']);
  settings['tasks:zero']['property:검토'] = false;
  settings['tasks:high']['property:검토'] = true;
  assert.deepEqual(projectTableRows(sections, { ...view, propertyFilter: { key: 'property:검토', value: false } }, settings).map(row => row.id), ['zero']);
});
