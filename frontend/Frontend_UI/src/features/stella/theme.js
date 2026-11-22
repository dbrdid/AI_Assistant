import { StyleSheet } from 'react-native';
export const palette = {
  background: '#191a1b',
  surface: '#222325',
  raised: '#2b2c2e',
  text: '#f0f0ee',
  muted: '#aaa',
  subtle: '#969a9c',
  line: '#2d3032',
  accent: '#b8cbb3',
  danger: '#f0abab'
};
const c = palette;
export const styles = StyleSheet.create({
  blockTypeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 12 },
  blockTypeOption: { width: '48%', minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, backgroundColor: c.surface, borderRadius: 7 },
  navigationHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: c.background },
  workspaceAvatar: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  workspaceInitial: { color: c.text, backgroundColor: '#343638', width: 30, height: 30, borderRadius: 15, textAlign: 'center', lineHeight: 30, fontSize: 16, fontWeight: '600', fontFamily: 'Georgia' },
  homePage: { paddingHorizontal: 20, paddingTop: 0, paddingBottom: 30 },
  homeSection: { marginBottom: 25 },
  homeSectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  homeSectionToggle: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  homeSectionLabel: { color: c.subtle, fontSize: 12, fontWeight: '400' },
  recentRail: { marginRight: -20 },
  recentRailContent: { gap: 10, paddingRight: 20, paddingBottom: 2 },
  recentCard: { width: 146, minHeight: 96, backgroundColor: c.surface, borderRadius: 6, overflow: 'hidden' },
  recentCover: { height: 58, backgroundColor: c.raised, overflow: 'hidden' },
  recentImage: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' },
  recentCardContent: { padding: 10, gap: 8 },
  recentCardHeading: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  recentExcerpt: { color: c.subtle, fontSize: 12, lineHeight: 17 },
  recentTitle: { flex: 1, color: c.text, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  homeReview: { flexDirection: 'row', alignItems: 'center', gap: 11, minHeight: 44 },
  homeDock: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, borderTopWidth: 1, borderTopColor: c.line },
  homeSearch: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 8 },
  homeSearchText: { color: c.muted, fontSize: 14 },
  recentBody:{color:c.muted,fontSize:12,lineHeight:18},
  emptyInline:{color:c.subtle,fontSize:13,lineHeight:22,paddingVertical:12},
  root: {
    flex: 1,
    backgroundColor: c.background
  },
  header: {
    borderBottomWidth: 0,
    borderBottomColor: c.line,
    paddingHorizontal: 16,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexShrink: 1
  },
  brandMark: {
    color: c.text,
    backgroundColor: '#343638',
    width: 32,
    height: 32,
    borderRadius: 4,
    textAlign: 'center',
    lineHeight: 32,
    fontSize: 21,
    fontWeight: '700',
    fontFamily: 'Georgia'
  },
  brandTitle: {
    color: c.text,
    fontSize: 14,
    fontWeight: '500',
    maxWidth: 210
  },
  brandSub: {
    color: c.muted,
    fontSize: 11,
    marginTop: 1
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2
  },
  iconButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 4
  },
  page: {
    paddingHorizontal: 20,
    paddingTop: 25,
    paddingBottom: 32
  },
  date: {
    color: c.subtle,
    fontSize: 12,
    marginBottom: 9
  },
  title: {
    color: c.text,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: -.4,
    lineHeight: 34
  },
  intro: {
    color: c.muted,
    fontSize: 13,
    lineHeight: 23,
    marginTop: 8
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  section: {
    marginTop: 24
  },
  sectionHead: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12
  },
  sectionTitle: {
    color: c.text,
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -.3
  },
  link: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'center',
    minHeight: 40
  },
  linkText: {
    color: c.muted,
    fontSize: 12
  },
  primary: {
    backgroundColor: c.raised,
    borderRadius: 4,
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    gap: 7,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start'
  },
  primaryText: {
    color: c.text,
    fontSize: 13,
    fontWeight: '600'
  },
  secondary: {
    borderWidth: 1,
    borderColor: c.line,
    minHeight: 44,
    paddingHorizontal: 13,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  secondaryText: {
    color: c.text,
    fontSize: 12
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 13,
    paddingVertical: 12,
    borderBottomWidth: 0,
    borderBottomColor: c.line
  },
  rowTitle: {
    color: c.text,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22
  },
  rowBody: {
    color: c.muted,
    fontSize: 12,
    lineHeight: 21,
    marginTop: 4
  },
  meta: {
    color: c.subtle,
    fontSize: 12,
    lineHeight: 19,
    marginTop: 7
  },
  reviewStrip: {
    backgroundColor: c.surface,
    borderRadius: 4,
    padding: 17,
    flexDirection: 'row',
    gap: 14,
    alignItems: 'center'
  },
  count: {
    color: c.text,
    fontSize: 25,
    fontVariant: ['tabular-nums'],
    minWidth: 26
  },
  stats: {
    borderTopWidth: 1,
    borderTopColor: c.line,
    paddingTop: 15,
    flexDirection: 'row',
    gap: 20
  },
  statLabel: {
    color: c.muted,
    fontSize: 11
  },
  statValue: {
    color: c.text,
    fontSize: 16,
    marginTop: 6
  },
  search: {
    backgroundColor: c.surface,
    borderRadius: 4,
    paddingHorizontal: 12,
    flexDirection: 'row',
    gap: 9,
    alignItems: 'center',
    marginTop: 20
  },
  searchInput: {
    flex: 1,
    color: c.text,
    fontSize: 13,
    minHeight: 46,
    paddingVertical: 10
  },
  filters: {
    flexDirection: 'row',
    gap: 20,
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    marginTop: 17
  },
  filter: {
    minHeight: 44,
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  filterOn: {
    borderBottomColor: c.text
  },
  filterText: {
    color: c.muted,
    fontSize: 12
  },
  empty: {
    color: c.muted,
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 24,
    paddingVertical: 30
  },
  note: {
    color: c.subtle,
    fontSize: 11,
    lineHeight: 20,
    marginTop: 20
  },
  error: {
    color: c.danger,
    fontSize: 12,
    lineHeight: 22,
    padding: 12,
    backgroundColor: c.surface
  },
  modalShade: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: '#0008'
  },
  sheet: {
    backgroundColor: c.surface,
    paddingHorizontal: 22,
    paddingTop: 15,
    paddingBottom: 30,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
    maxHeight: '85%'
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 3,
    backgroundColor: '#666',
    marginBottom: 17
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    borderBottomWidth: 0,
    borderBottomColor: c.line
  },
  menuLabel: {
    color: c.text,
    fontSize: 13,
    flex: 1
  },
  editorTitle: {
    color: c.text,
    fontSize: 30,
    fontWeight: '600',
    letterSpacing: -.8,
    lineHeight: 40,
    padding: 0,
    paddingTop: 10,
    paddingBottom: 8
  },
  editorBody: {
    color: c.text,
    fontSize: 16,
    lineHeight: 28,
    minHeight: 300,
    paddingTop: 20,
    paddingHorizontal: 0,
    textAlignVertical: 'top'
  },
  editorTools: {
    flexDirection: 'row',
    gap: 0,
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: c.line,
    backgroundColor: c.background,
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  proposal: {
    paddingVertical: 19,
    borderTopWidth: 1,
    borderTopColor: c.line
  },
  proposalBody: {
    color: c.muted,
    fontSize: 13,
    lineHeight: 24,
    marginTop: 12
  }
});
