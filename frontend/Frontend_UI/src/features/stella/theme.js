import { StyleSheet } from 'react-native';
// 색 기준은 공용 테마의 palette 하나 (shared/theme/theme.js)
import { palette } from '../../shared/theme/theme';
export { palette };
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
  askPill: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: c.surface },
  recentBody:{color:c.muted,fontSize:12,lineHeight:18},
  // 본문 아래 하위·연결 문서: Notion 페이지 링크처럼 낮은 대비의 행, 누를 때만 면 표시
  pageLinks: { marginTop: 32, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
  pageLinksLabel: { color: c.subtle, fontSize: 12, marginBottom: 4 },
  pageLink: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: 6 },
  pageLinkPressed: { backgroundColor: c.surface },
  pageLinkTitle: { flex: 1, color: c.text, fontSize: 15, textDecorationLine: 'underline', textDecorationColor: '#55595c' },
  pageLinkKind: { color: c.subtle, fontSize: 11 },
  // 문서 작업 메뉴의 바로가기 묶음(Notion 작업 시트의 둥근 묶음 행)
  menuGroup: { backgroundColor: c.surface, borderRadius: 10, marginTop: 10, paddingHorizontal: 12, overflow: 'hidden' },
  menuGroupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 46 },
  menuDivider: { height: StyleSheet.hairlineWidth, backgroundColor: c.line, marginLeft: 34 },
  menuGroupLabel: { color: c.subtle, fontSize: 12, marginTop: 18, marginBottom: 2, paddingHorizontal: 4 },
  menuIcon: { width: 22, alignItems: 'center' },
  // AI 요청 화면
  promptBox: { color: c.text, fontSize: 15, lineHeight: 23, minHeight: 104, maxHeight: 240, marginTop: 16, padding: 14, backgroundColor: c.surface, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: '#3a3d40', textAlignVertical: 'top' },
  aiTarget: { color: c.muted, fontSize: 13, lineHeight: 20, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: c.accent },
  aiActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 },
  aiSend: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingHorizontal: 16, borderRadius: 22, backgroundColor: '#35373a' },
  aiSendText: { color: c.text, fontSize: 14, fontWeight: '600' },
  aiGhost: { flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 0, borderColor: '#45494c',
    backgroundColor: c.raised
  },
  aiGhostText: { color: c.text, fontSize: 13 },
  aiConsent: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, marginTop: 6 },
  aiReply: { marginTop: 20, padding: 14, backgroundColor: c.surface, borderRadius: 10 },
  aiReplyLabel: { color: c.subtle, fontSize: 12, marginBottom: 8 },
  aiConnection: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, marginTop: 22, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
  aiConnectionText: { flex: 1, color: c.subtle, fontSize: 12 },
  // AI 연결 카드(Orca 에이전트 연결 화면 참고): 낮은 대비의 면, 옅은 테두리, 오른쪽 상태 배지
  connCard: { padding: 14, gap: 8, backgroundColor: c.surface, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: '#2e3134' },
  connCardOn: { borderColor: '#4a4e52' },
  connHead: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  connName: { flex: 1, color: c.text, fontSize: 15, fontWeight: '600' },
  connBadge: { color: c.subtle, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 0, borderColor: '#45494c', overflow: 'hidden',
    backgroundColor: c.raised
  },
  connBadgeOn: { color: c.text, backgroundColor: '#35373a', borderColor: '#35373a' },
  connBadgeReady: { color: c.text, borderColor: '#55595c' },
  connDesc: { color: c.muted, fontSize: 12, lineHeight: 18 },
  connDetails: { gap: 8, marginTop: 4, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
  connRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 },
  connRowLabel: { color: c.muted, fontSize: 13, width: 44 },
  connRowValue: { flex: 1, color: c.text, fontSize: 14 },
  connInput: { color: c.text, fontSize: 14, minHeight: 44, paddingHorizontal: 12, backgroundColor: c.background, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: '#3a3d40' },
  connNote: { color: c.subtle, fontSize: 12, lineHeight: 18 },
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
    borderWidth: 0,
    borderColor: c.line,
    minHeight: 44,
    paddingHorizontal: 13,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.raised
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
