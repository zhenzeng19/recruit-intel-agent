// ============================================================
// 简历正文的文本处理与字段提取 —— web / server / extension 共用
// ------------------------------------------------------------
// 为什么这些逻辑放在共享包：
//   采集端（扩展）要判断「这一块像不像简历」并算去重主键；
//   服务端要把正文提取成姓名/学历/城市等字段；
//   两边原本各写了一份「在前几行找 2–4 个汉字 = 姓名」，结果一起踩了
//   同一个坑（简历面板顶部的按钮「查看大图」正好 4 个汉字且比真名靠前）。
//   放一份只维护一次，也不再各自漂移。
//
// ★ 2026-10-05 重写：从「标签驱动」升级为「头部区块 + 三种证据」★
// ------------------------------------------------------------
// 起因（用真实采集数据查出来的）：旧实现找的是 `性别：男`、`毕业院校：X`、
// `现居：X` 这类**带标签**的行 —— 而那是「示例数据」的格式。真实猎聘页面的
// 头部是「**裸行 + `·` 分隔**」：
//
//     推荐职位：
//     项目经理
//     查看大图
//     孙先生                        ← 姓名（含称呼 → 性别线索）
//     更新简历时间：…
//     北京                          ← 城市（裸行，无标签）
//     工作17年                      ← 工作年限（裸行）
//     39 岁
//     离职，正在找工作
//     河北工业大学 · 土木工程 · 本科 · 统招   ← 一行四个字段！
//
// 于是标签找不到 → 性别/学校/专业/统招/年限全空，而「测试全绿」（因为示例数据
// 恰好是标签格式）。教训：**造样本必须包含真实页面格式**。
//
// 现在的做法：
//   ① 先把正文切成「头部字段区 / 章节自由文本区」—— 头部是结构化字段区，
//      往下是自由文本。字段提取只在头部做（少数需要全文的除外，如技能标签）。
//      这一刀同时修掉「城市抓错」「公司抓错」两个老问题（它们本质都是缺这个
//      切分而在打补丁）。
//   ② 头部内按三级证据依次取：显式标签 → `·` 分隔符行 → 位置/称呼规则。
// ============================================================
import type { Candidate } from './index.ts'

// ------------------------------------------------------------ 词表

/** 简历正文里高频出现的章节词 —— 判断「这块内容像不像一份简历」 */
export const RESUME_SECTION_WORDS: readonly string[] = [
  '工作经历',
  '工作经验',
  '教育经历',
  '教育背景',
  '项目经历',
  '项目经验',
  '实习经历',
  '自我评价',
  '自我描述',
  '个人优势',
  '个人简介',
  '求职意向',
  '期望职位',
  '期望薪资',
  '期望城市',
  '专业技能',
  '技能特长',
  '毕业院校',
  '最高学历',
  '到岗时间',
  '离职时间',
  '在职时间',
  '工作描述',
  '工作内容',
]

/**
 * 简历面板内部的「按钮 / 操作文案」。
 *
 * 两个害处 ——
 *   ① 被当成姓名（「查看大图」是 4 个汉字，且比真名更靠前）；
 *   ② 两次打开的按钮组合不同（有时多一个「继续沟通」），
 *      导致同一份简历的正文长度、内容指纹都不同 → 同一个人被存成两条档案。
 * 所以它们既要在「像不像简历」打分里扣分，也要在姓名识别与指纹计算前剔除。
 */
export const UI_CHROME_WORDS: readonly string[] = [
  '查看大图',
  '意向沟通',
  '发起意向沟通',
  '继续沟通',
  '立即沟通',
  '主动沟通',
  '打招呼',
  '展开',
  '收起',
  '折叠',
  '查看更多',
  '查看全部',
  '查看附件',
  '查看详情',
  '查看简历',
  '在线简历',
  '附件简历',
  '下载简历',
  '发送简历',
  '收藏',
  '举报',
  '分享',
  '转发',
  '电话沟通',
  '交换微信',
  '交换电话',
  '获取联系方式',
  '请求简历',
  '上一页',
  '下一页',
  '返回',
  '关闭',
  '取消',
  '确定',
  '保存',
  '不合适',
  '已读',
  '未读',
  '置顶',
  '删除',
  '刷新',
  '重新加载',
  // 猎聘简历面板底部的一排服务入口（也会被一起圈进容器里）
  '觉得TA还不错',
  '背景调查',
  '雇前背景调查',
  '邀请面试',
  '发送面试邀请',
  '添加备注',
  '移入人才库',
  '通过筛选',
  // 猎聘详情页/预览面板底部的操作区（真实数据里在正文最后 19 行，必须剥掉）
  '获取电话',
  '超级聊聊',
  '免费发起',
  '免费权益',
  '操作记录',
  '人才招聘记录',
  '该候选人无人才招聘记录',
  '简历备注',
  '暂无备注内容',
  '向TA索要',
  '已上传附件简历',
  '已上传个人作品',
  '附件简历与个人作品',
  '中文简历',
  '英文简历',
  // 猎聘搜索页 / 预览面板上的文案（真实数据里「快速定位：」曾被当成候选人姓名）
  '快速定位：',
  '快速定位',
  '英语作为工作语言',
  '作为工作语言',
]

/** 纯中文姓名行（含少数民族姓名的间隔号） */
const NAME_LINE = /^[\u4e00-\u9fa5][\u4e00-\u9fa5·]{1,3}$/

/**
 * **打码姓名**：猎聘对设置了隐私的候选人会显示成 `王**` / `李*`。
 * 这是平台给的真实展示形式，能认出来就比「未识别姓名」有用得多 ——
 * 真实的踩坑案例：一份 `王**` 的简历因为认不出姓名，兜底逻辑把搜索页的
 * 「快速定位：」当成了姓名，直接写进了姓名列。
 */
const MASKED_NAME_LINE = /^[\u4e00-\u9fa5]{1,2}\*{1,3}$/

/**
 * 带「·」的少数民族姓名（`买买提·艾力`）。
 * ⚠️ 这类长名字以前认不出来（`NAME_LINE` 上限 4 字），但放宽有风险 ——
 *    `本科 · 土木工程`、`河北工业大学 · 土木工程` 这种「学历/院校 · 专业」行
 *    形态完全一样。所以必须配合 `NOT_NAME_RE` 里的机构/专业词排除。
 */
const ETHNIC_NAME_LINE = /^[\u4e00-\u9fa5]{1,4}·[\u4e00-\u9fa5]{1,6}$/

/** 机构 / 专业 / 学历词 —— 含这些词的行不可能是姓名（用来给上面那条放宽兜底） */
const ORG_OR_MAJOR_RE =
  /(大学|学院|学校|中学|高中|专业|本科|专科|硕士|博士|研究生|学位|MBA|EMBA)/

/** 简历头部用于「定位姓名」的特征行 */
const HEAD_HINTS =
  /(今天活跃|昨日活跃|最近活跃|本周活跃|更新简历|在职|离职|正在找工作|求职|\d+\s*岁|工作\s*\d+\s*年)/

/** 一眼就不可能是姓名的行：纯数字、含数字、含邮箱/URL、按钮或章节标签 */
export function looksLikeChromeOrJunk(line: string): boolean {
  if (/\d/.test(line)) return true
  if (/[@:/\\()（）[\]【】<>]/.test(line)) return true
  if (UI_CHROME_WORDS.some((w) => line === w || line.includes(w))) return true
  if (RESUME_SECTION_WORDS.some((w) => line.includes(w))) return true
  return false
}

/**
 * 从简历正文里猜姓名。
 *
 * 顺序：
 *   ① 显式的「姓名：张三」标签（最可靠）
 *   ② 头部特征行 → 该行**前面**那一行通常就是姓名
 *      （猎聘/BOSS 头部形如：张小雨 / 今天活跃 / 更新简历时间：… / 青岛 / 工作2年）
 *   ③ 宽松兜底：正文靠前的 2–4 个汉字行，先过一遍垃圾行过滤
 */
export function guessResumeName(text: string): string {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''

  /**
   * 这一行看着像姓名，其实不可能是。
   *
   * ⚠️ 三个真实踩坑（都是「2~4 个汉字」这个宽松判据带来的）：
   *   ① **城市**：第 ② 步是「找到头部特征行后往前最多 3 行找姓名」。
   *      猎聘真实文本里姓名与「工作N年」之间隔着 `今天活跃 / 更新简历时间 / 青岛`，
   *      往前找会先命中姓名；但**只要布局是「姓名 / 城市 / 工作N年」三行相连**
   *      （别的站点、或离线导入的简历就可能这样），就会把城市当姓名 ——
   *      实测 `李先生\n盐城\n工作15年` 解析出的姓名是「盐城」。
   *   ② **学历/状态词**：`王五\n深圳\n本科\n30 岁` 会解析出姓名是「本科」。
   *   ③ **机构/专业**：`河北工业大学 · 土木工程` 必须排除，否则放宽少数民族姓名后
   *      会把学历行当成姓名。
   * 城市名或「本科」出现在姓名列里是彻底的错误数据，所以显式排除。
   * 学历判定复用 `isDegreeToken` / `normalizeEducationMode`，避免又维护一份学历词表。
   */
  const notNameLike = (l: string): boolean =>
    CITY_LIST.includes(l) ||
    /^(全部行业|其他|不限)$/.test(l) ||
    isDegreeToken(l) ||
    // ⚠️ 必须是真值判断：normalizeEducationMode 认不出来时返回的是**空字符串**而不是 null，
    //    写成 `!== null` 会把每一行都判成「不可能是姓名」，姓名直接全空（踩过）。
    !!normalizeEducationMode(l) ||
    ORG_OR_MAJOR_RE.test(l) ||
    NOT_NAME_RE.test(l)

  /** 姓名行的三种形态 + 三重排除 */
  const looksLikeName = (l: string): boolean =>
    (NAME_LINE.test(l) || MASKED_NAME_LINE.test(l) || ETHNIC_NAME_LINE.test(l)) &&
    !notNameLike(l) &&
    !looksLikeChromeOrJunk(l)

  // ① 显式标签
  for (const l of lines.slice(0, 40)) {
    const m = /姓\s*名[:：\s]*([\u4e00-\u9fa5·*]{2,4})/.exec(l)
    if (m) return m[1]
  }

  // ② 靠头部特征行反推
  const headEnd = Math.min(lines.length, 30)
  for (let i = 1; i < headEnd; i++) {
    if (!HEAD_HINTS.test(lines[i])) continue
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (looksLikeName(lines[j])) return lines[j]
    }
  }

  // ③ 宽松兜底
  for (const l of lines.slice(0, 20)) {
    if (looksLikeName(l)) return l
  }
  return ''
}

/**
 * 姓名兜底：在前若干行里找第一个「像姓名」的行。
 *
 * 为什么需要它：`parseResumeText` 原本的兜底是 `lines[0]?.slice(0,12)` ——
 * **直接取第一行**。而采集容器的第一行经常是 UI 文案：真实数据里
 * 一份 `王**`（打码姓名）的简历因为认不出姓名，姓名列被写成了 **「快速定位：」**
 * （猎聘搜索页的一个按钮）。宁可写「未识别姓名」，也不能把界面文案当人名。
 */
export function scanForNameLine(lines: string[], limit = 30): string {
  for (const l of lines.slice(0, limit)) {
    const t = l.trim()
    if (!t || t.length > 12) continue
    // 兜底这一层比主路径略宽（允许 2~6 个纯汉字）：主路径的 `NAME_LINE` 卡在 4 字，
    // 而 5 字的姓名（`欧阳修文` 之外的复姓/长名、以及 BOSS 紧凑格式里的姓名行）
    // 会因此落到「未识别姓名」，等于比以前退步。放宽的代价用**职位词排除**兜住 ——
    // 否则 `高级工程师`（5 字）这种行会被当成姓名。
    if (!/^[\u4e00-\u9fa5*]{2,6}$/.test(t)) continue
    if (TITLE_WORD_RE.test(t)) continue
    if (CITY_LIST.includes(t) || ORG_OR_MAJOR_RE.test(t) || NOT_NAME_RE.test(t)) continue
    if (isDegreeToken(t) || normalizeEducationMode(t)) continue
    if (looksLikeChromeOrJunk(t)) continue
    return t
  }
  return ''
}

/** 一眼就不可能是姓名的词（学历已在 notNameLike 里用 DEGREE_RULES 处理，这里补状态/泛化词） */
const NOT_NAME_RE =
  /(活跃|在职|离职|求职|到岗|应届|往届|期望|行业|岗位|职位|薪资|统招|全日制|自考|成教|远程|兼职|实习)/

// ------------------------------------------------------------ 城市词典

/**
 * 招聘场景高频城市。
 *
 * ⚠️ 这个表**必须够全**：真实案例里「盐城」不在旧表中，导致候选人的城市字段为空
 * （正文明明写着「盐城」）。词典不全 + 没有兜底 = 字段静默丢失。
 * 现在除了扩充本表，`extractCity()` 还有「锚点邻域内的短中文行」兜底，
 * 两者互为补充。
 */
export const CITY_LIST: readonly string[] = [
  // 直辖市 / 一线
  '北京', '上海', '天津', '重庆',
  // 广东
  '广州', '深圳', '东莞', '佛山', '珠海', '惠州', '中山', '江门', '肇庆', '汕头',
  '湛江', '茂名', '揭阳', '潮州', '梅州', '清远', '韶关', '阳江', '河源', '云浮', '汕尾',
  // 江苏
  '南京', '苏州', '无锡', '常州', '南通', '徐州', '扬州', '盐城', '泰州', '镇江',
  '淮安', '连云港', '宿迁',
  // 浙江
  '杭州', '宁波', '温州', '嘉兴', '绍兴', '台州', '金华', '湖州', '衢州', '丽水', '舟山',
  // 山东
  '济南', '青岛', '烟台', '潍坊', '淄博', '威海', '临沂', '济宁', '泰安', '德州',
  '聊城', '滨州', '东营', '枣庄', '日照', '菏泽',
  // 福建
  '福州', '厦门', '泉州', '漳州', '莆田', '宁德', '三明', '南平', '龙岩',
  // 四川
  '成都', '绵阳', '德阳', '宜宾', '南充', '泸州', '自贡', '乐山', '内江', '遂宁', '眉山',
  // 湖北 / 湖南
  '武汉', '宜昌', '襄阳', '荆州', '黄石', '十堰', '孝感', '荆门',
  '长沙', '株洲', '湘潭', '衡阳', '岳阳', '常德', '郴州', '益阳', '娄底', '邵阳',
  // 河南 / 河北
  '郑州', '洛阳', '新乡', '许昌', '焦作', '南阳', '开封', '安阳', '平顶山', '商丘',
  '石家庄', '唐山', '保定', '廊坊', '沧州', '邯郸', '秦皇岛', '张家口', '承德', '邢台', '衡水',
  // 陕西 / 山西
  '西安', '咸阳', '宝鸡', '渭南', '榆林', '汉中',
  '太原', '大同', '临汾', '运城', '长治', '晋城', '晋中',
  // 安徽 / 江西
  '合肥', '芜湖', '蚌埠', '马鞍山', '安庆', '滁州', '阜阳', '宿州', '六安',
  '南昌', '赣州', '九江', '上饶', '宜春', '吉安', '抚州', '景德镇', '萍乡',
  // 东北
  '沈阳', '大连', '鞍山', '抚顺', '本溪', '营口', '锦州', '丹东',
  '长春', '吉林', '四平', '延边', '通化',
  '哈尔滨', '大庆', '齐齐哈尔', '牡丹江', '佳木斯',
  // 西南 / 西北
  '昆明', '曲靖', '玉溪', '大理', '红河',
  '贵阳', '遵义', '六盘水', '安顺',
  '南宁', '柳州', '桂林', '北海', '玉林', '梧州', '钦州',
  '兰州', '天水', '酒泉',
  '银川', '西宁', '乌鲁木齐', '克拉玛依', '呼和浩特', '包头', '鄂尔多斯',
  '拉萨', '海口', '三亚', '儋州',
  // 港澳台
  '香港', '澳门', '台北', '新北', '台中', '高雄',
]

/** 「期望城市 / 意向城市」—— 这是求职者**想去**的地方，不是他现在在哪 */
const CITY_WISH_LABEL = /(期望城市|期望地点|意向城市|意向地点|目标城市|期望工作地)/
/** 显式标注「居住地」的字段名 */
const CITY_LABEL = /(现居|现居住|居住地|所在地|所在城市|城市|工作地点|居住城市|目前所在)/
/** 定位居住地的锚点：这些词旁边就是城市名 */
const CITY_ANCHOR = /(\d{1,2}\s*岁|工作\s*\d+\s*年|工作年限|离职|在职|正在找工作|活跃|更新简历|求职状态)/

/** 长得像城市但绝不是城市的行（避免把状态词当城市） */
const NON_CITY_WORDS = [
  '今天活跃', '昨日活跃', '最近活跃', '本周活跃', '本月活跃', '三天内活跃', '3天内活跃',
  '更新简历', '离职', '在职', '正在找工作', '看看新机会', '暂不考虑', '面议', '保密',
  '男', '女', '已婚', '未婚', '本科', '硕士', '博士', '大专', '统招', '非统招', '全职', '兼职',
  '推荐职位', '求职意向', '展开', '收起',
]

// ------------------------------------------------------------ 学历

/** 学历词（含猎聘/BOSS 常见写法），按「高→低」的顺序用于优先匹配 */
const DEGREE_RULES: Array<{ re: RegExp; value: string }> = [
  { re: /博士后|博士/, value: '博士' },
  { re: /硕士|研究生|MBA|EMBA/, value: '硕士' },
  { re: /本科|学士/, value: '本科' },
  { re: /大专|专科|高职|高专/, value: '大专' },
  { re: /中专|中技|职高/, value: '中专' },
  { re: /高中/, value: '高中' },
]

/** 是否命中「学历词」——分隔符行分类时用 */
export function isDegreeToken(s: string): boolean {
  return DEGREE_RULES.some((r) => r.re.test(s))
}

/**
 * 学历性质（统招 / 非统招 / 专升本）。
 *
 * ⚠️ 顺序至关重要：`非统招` 必须排在 `统招` 前面，否则「非统招」会被匹配成「统招」。
 *    而 `统招` 又要排在 `专升本` 前面 —— 因为「统招专升本」其实是全日制本科，
 *    此时正确的结论是「统招」而不是「专升本」。
 *
 * 归一化：统招/全日制 → 统招；非统招/非全日制/自考/成人/函授/夜大/网络教育 → 非统招；
 *        专升本单独保留（它是学历路径，不是统招属性）。
 */
const EDU_MODE_RE =
  /非统招|非全日制|自学考试|自考|成人教育|成人高考|成教|函授|夜大|业余|网络教育|远程教育|统招|全日制|专升本/

export function normalizeEducationMode(raw: string): string {
  const m = EDU_MODE_RE.exec(raw || '')
  if (!m) return ''
  const hit = m[0]
  if (hit === '统招' || hit === '全日制') return '统招'
  if (hit === '专升本') return '专升本'
  return '非统招'
}

// ------------------------------------------------------------ 院校层次

/** 985（39 所，完整） */
export const SCHOOL_985: readonly string[] = [
  '清华大学', '北京大学', '中国人民大学', '北京航空航天大学', '北京理工大学',
  '中国农业大学', '北京师范大学', '中央民族大学', '南开大学', '天津大学',
  '大连理工大学', '东北大学', '吉林大学', '哈尔滨工业大学', '复旦大学',
  '同济大学', '上海交通大学', '华东师范大学', '南京大学', '东南大学',
  '浙江大学', '中国科学技术大学', '厦门大学', '山东大学', '中国海洋大学',
  '武汉大学', '华中科技大学', '中南大学', '湖南大学', '国防科技大学',
  '中山大学', '华南理工大学', '四川大学', '电子科技大学', '重庆大学',
  '西安交通大学', '西北工业大学', '西北农林科技大学', '兰州大学',
]

/**
 * 211（非 985 部分）。⚠️ 列表可扩充 —— 漏掉只会让 schoolTier 为空（安全），
 * 不会误判成 211（危险），所以宁可少列也不要列错。
 */
export const SCHOOL_211: readonly string[] = [
  '北京交通大学', '北京工业大学', '北京科技大学', '北京化工大学', '北京邮电大学',
  '北京林业大学', '北京中医药大学', '北京外国语大学', '中国传媒大学', '中央财经大学',
  '对外经济贸易大学', '北京体育大学', '中央音乐学院', '中国政法大学', '华北电力大学',
  '天津医科大学', '河北工业大学', '太原理工大学', '内蒙古大学', '辽宁大学',
  '大连海事大学', '延边大学', '东北师范大学', '哈尔滨工程大学', '东北农业大学',
  '东北林业大学', '华东理工大学', '东华大学', '上海外国语大学', '上海财经大学',
  '上海大学', '苏州大学', '南京航空航天大学', '南京理工大学',
  '中国矿业大学', '河海大学', '江南大学', '南京农业大学', '中国药科大学',
  '南京师范大学', '安徽大学', '合肥工业大学', '福州大学', '南昌大学',
  '郑州大学', '武汉理工大学', '中国地质大学', '华中农业大学', '华中师范大学',
  '中南财经政法大学', '湖南师范大学', '暨南大学', '华南师范大学', '广西大学',
  '海南大学', '西南交通大学', '西南财经大学', '四川农业大学', '西南大学',
  '贵州大学', '云南大学', '西藏大学', '西北大学', '西安电子科技大学',
  '长安大学', '陕西师范大学', '青海大学', '宁夏大学', '新疆大学', '石河子大学',
  '中国石油大学',
]

/** 院校名归一化：去掉空白与括号补充说明 */
const normSchool = (s: string): string =>
  (s || '').replace(/[\s\u3000]/g, '').replace(/[（(][^)）]*[)）]/g, '')

/**
 * 判定院校层次：显式 985/211/双一流 标记优先，其次**精确匹配**院校名单。
 *
 * ⚠️ 为什么要精确匹配而不是 `includes`：
 *    用 `includes` 时「西安电子科技大学」会命中名单里的「电子科技大学」→
 *    被判成 **985**（它其实是 211），「桂林电子科技大学」也被判成 985。
 *    **错判成更高层次比判不出来危险得多** —— HR 会据此高估候选人。
 *    所以宁可少判（返回空）也绝不错判。
 *    名单要扩充时请加**完整校名**。
 */
export function schoolTierOf(text: string, school?: string): string {
  const t = text || ''
  if (/985/.test(t)) return '985'
  if (/211/.test(t)) return '211'
  if (/双一流/.test(t)) return '双一流'
  const s = normSchool(school || '')
  if (!s) return ''
  if (SCHOOL_985.some((x) => normSchool(x) === s)) return '985'
  if (SCHOOL_211.some((x) => normSchool(x) === s)) return '211'
  return ''
}

// ------------------------------------------------------------ 技能词典（即行业术语表）

/**
 * 行业术语表 —— 既用于 JD 匹配打分，也用于给简历打技能标签。
 * 放在共享包是因为两边都要用（服务端打分 + 字段提取打标）。
 *
 * 定位：**刻意不做分词**。这个行业的写法高度固定（OpenCV / Halcon / 缺陷检测 /
 * Zemax…），维护一份术语表比通用分词更准、也更好解释给 HR 听。
 */
export const TECH_TERMS: readonly string[] = [
  // 编程语言 / 框架 / 工具
  'Python', 'C++', 'C#', 'PyTorch', 'TensorFlow', 'PaddlePaddle', 'Keras',
  'OpenCV', 'Halcon', 'VisionPro', 'MATLAB', 'CUDA', 'TensorRT', 'ONNX',
  'Qt', 'MFC', 'Linux', 'CMake', 'Git', 'Docker', 'PLC', 'EtherCAT', 'Modbus',
  '多线程', '网络通信', '上位机', '界面开发', '软硬件联调', 'Shell',
  // 算法方向
  '深度学习', '机器学习', '计算机视觉', '图像处理', '图像预处理', '特征提取',
  '缺陷检测', '目标检测', '语义分割', '实例分割', '图像分割', '异常检测',
  '小样本', '检测网络', '传统视觉', '标定', '配准', '拼接', '去噪',
  '模型压缩', '量化', '剪枝', '蒸馏', '推理加速', '多模态', '大模型',
  'Transformer', 'CNN', 'YOLO', 'U-Net', 'GAN', 'OCR', '3D视觉', '点云',
  '自监督学习', '数据增强', '难例挖掘', '亚像素', '图像配准', '边缘检测',
  // 设备 / 行业
  '半导体', '晶圆', '面板', 'LCD', 'OLED', '3C', '光伏', '锂电', '新能源',
  'AOI', '量测', '检测设备', '光刻', '封装', '先进封装', '良率', '过杀',
  '漏检', '节拍', '产线', '量产', '设备控制', '运动控制', '视觉引导', '机器人',
  'SEMI', '稼动率', 'MES', '故障排查', '设备调试', '缺陷分析',
  // 光学
  '光学设计', '光学工程', 'Zemax', 'Code V', 'LightTools', '光路', '成像',
  '照明', 'MTF', '像差', '公差分析', '干涉', '显微', '偏振', '光谱',
  '相机', '镜头', '光源', '机器视觉', '工业相机', '光机', '共聚焦', '光学测量',
  // 工程 / 协作
  '需求分析', '方案设计', '算法落地', '工程化', '量产落地', '客户现场',
  '现场调试', '售后支持', '售前', '培训', '专利', '论文', '团队管理',
  '项目管理', '跨部门', '带教', '客户支持', '方案讲解', '设备演示', '英文沟通',
  // 学历（这些是「要求」不是「技能」，打技能标签时要排除）
  '硕士', '博士', '本科', '统招', '985', '211', '双一流', '留学',
]

/** 不属于「技能」的术语（学历类 + 过于泛化的动词），打技能标签时排除 */
export const NON_SKILL_TERMS: readonly string[] = [
  '硕士', '博士', '本科', '统招', '985', '211', '双一流', '留学',
  '标定', '配准', '拼接', '去噪', '成像', '照明', '干涉', '显微', '光谱', '相机', '镜头', '光源',
]

/**
 * 技能标签词典 = 行业术语 − 学历/泛化词。
 * 用它给简历自动打技能标签：**零成本**让人才 Map 的技能云对真实数据也有内容
 * （在此之前真实采集的简历 skills 全是空的，只有示例数据有）。
 *
 * 注意：命中的结果是 `skillsSource: 'dictionary'`（词典命中），
 * 不是大模型抽取 —— 语义上必须区分开，别让 HR 以为这是模型判断的。
 */
export const SKILL_TERMS: readonly string[] = TECH_TERMS.filter(
  (t) => !NON_SKILL_TERMS.includes(t)
)

// ------------------------------------------------------------ 头部 / 章节切分

function cleanLines(text: string): string[] {
  return (text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean)
}

/** 章节标题行：`【工作经历】` 或 短行且命中章节词 */
function isSectionHeading(line: string): boolean {
  if (/^【.+】$/.test(line)) return true
  if (line.length > 14) return false
  return RESUME_SECTION_WORDS.some((w) => line.includes(w))
}

export interface ResumeParts {
  /** 头部：姓名/年龄/城市/学历/薪资等结构化字段区 */
  header: string[]
  /** 章节区：自由文本（工作经历/项目/自评…），字段提取基本不碰这里 */
  sections: string[]
  /** 全部行 */
  lines: string[]
}

/**
 * 把正文切成「头部字段区」和「章节自由文本区」。
 *
 * 为什么这是根因修复：头部是一小段结构化字段（姓名/年龄/城市/学历/薪资），
 * 往下是自由文本（工作经历里什么公司名、项目名都可能出现）。
 * 不做这个切分，就只能用「含『有限公司』的首行」这种规则去猜公司 ——
 * 猜到的可能是工作经历里的任意一家，而不是当前这家。
 */
export function splitResume(text: string): ResumeParts {
  const lines = cleanLines(text)
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (isSectionHeading(lines[i])) {
      cut = i
      break
    }
  }
  return { header: lines.slice(0, cut), sections: lines.slice(cut), lines }
}

// ------------------------------------------------------------ 分隔符行

const SEPARATOR_RE = /\s*[·•‧|｜/／]\s*/

/**
 * 解析「`学校 · 专业 · 本科 · 统招`」这种分隔符行。
 * 猎聘的学历行就是这个格式 —— **一行出四个字段**，性价比最高。
 *
 * 只有当行内至少命中一个「学历词 / 学校词 / 统招词」时才认，
 * 避免把含 `/` 的普通句子（如「上位机/界面开发」）误当成字段行。
 */
export interface SeparatorFields {
  school?: string
  major?: string
  degree?: string
  educationMode?: string
  parts: string[]
}

const SCHOOL_TOKEN_RE = /(大学|学院|研究院|学校|职业学院|职业技术学院)/

export function parseSeparatorLine(line: string): SeparatorFields | null {
  const parts = (line || '')
    .split(SEPARATOR_RE)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length < 2) return null

  const looksStructured =
    parts.some((p) => SCHOOL_TOKEN_RE.test(p)) ||
    parts.some((p) => isDegreeToken(p)) ||
    parts.some((p) => EDU_MODE_RE.test(p))
  if (!looksStructured) return null

  const out: SeparatorFields = { parts }
  const leftovers: string[] = []

  for (const p of parts) {
    // 顺序要紧：含「大学/学院」的段优先当学校（避免把「XX大学」当成专业）
    if (!out.school && SCHOOL_TOKEN_RE.test(p) && p.length <= 24) {
      out.school = p
      continue
    }
    if (!out.degree) {
      for (const r of DEGREE_RULES) {
        if (r.re.test(p) && p.length <= 8) {
          out.degree = r.value
          break
        }
      }
      if (out.degree) continue
    }
    if (!out.educationMode && EDU_MODE_RE.test(p) && p.length <= 8) {
      out.educationMode = normalizeEducationMode(p)
      continue
    }
    leftovers.push(p)
  }

  if (!out.major && leftovers.length > 0) {
    // 专业通常是剩余段里最长的那个中文段
    const cand = leftovers
      .filter((p) => /^[\u4e00-\u9fa5A-Za-z（）()·\-]{2,20}$/.test(p))
      .sort((a, b) => b.length - a.length)[0]
    if (cand) out.major = cand
  }
  return out
}

// ------------------------------------------------------------ 城市

/** 头部锚点邻域内的「短中文行」当作城市候选（不依赖词典，兜住词典缺项） */
function cityFromAnchorWindow(lines: string[]): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    if (!CITY_ANCHOR.test(lines[i])) continue
    const lo = Math.max(0, i - 2)
    const hi = Math.min(lines.length - 1, i + 2)
    // 先按词典找（准确率高）
    for (let j = lo; j <= hi; j++) {
      const hit = CITY_LIST.find((c) => lines[j].includes(c))
      if (hit) return hit
    }
    // 词典没命中 → 取窗口内第一个「短中文行」当城市（猎聘头部就是裸行城市）
    for (let j = lo; j <= hi; j++) {
      const l = lines[j]
      if (!/^[\u4e00-\u9fa5]{2,4}$/.test(l)) continue
      if (NON_CITY_WORDS.some((w) => l.includes(w))) continue
      if (isDegreeToken(l)) continue
      if (RESUME_SECTION_WORDS.some((w) => l.includes(w))) continue
      return l
    }
  }
  return undefined
}

export function extractCity(lines: string[]): string | undefined {
  // 1) 显式「居住地」标签优先（「现居：深圳」）—— 但要排除「期望城市」
  for (const l of lines) {
    if (CITY_WISH_LABEL.test(l)) continue
    if (CITY_LABEL.test(l)) {
      const hit = CITY_LIST.find((c) => l.includes(c))
      if (hit) return hit
    }
  }
  // 2) 锚点邻域（词典 → 短中文行兜底）
  const near = cityFromAnchorWindow(lines)
  if (near) return near
  // 3) 期望城市（求职意向）—— 只能当兜底，不能优先于现状
  for (const l of lines) {
    if (CITY_WISH_LABEL.test(l)) {
      const hit = CITY_LIST.find((c) => l.includes(c))
      if (hit) return hit
    }
  }
  // 4) 全文兜底：取第一个出现的城市
  return CITY_LIST.find((c) => lines.some((l) => l.includes(c)))
}

// ------------------------------------------------------------ 各字段

/**
 * 取「标签：值」里的值。
 *
 * ⚠️ 两个坑都踩过：
 *   ① 正则里 `labelRe` 自带一个捕获组，所以**值是第 2 组**，
 *      读 `m[1]` 会拿到标签本身（表现为 school = "毕业院校"）。
 *      真实猎聘数据没有标签，走的全是兜底分支，所以这个 bug 只在
 *      「标签格式」的数据上暴露 —— 又一次「样本格式不对 → 测试给出虚假安全感」。
 *   ② 种子的头部把多个字段挤在一行（`学历：硕士 毕业院校：X 专业：Y`），
 *      贪婪的 `(.+)` 会一路吃到行尾。用 lookahead 在**下一个标签**处截断。
 */
function labeledValue(lines: string[], labelRe: RegExp, maxLen = 40): string | undefined {
  const re = new RegExp(
    `${labelRe.source}\\s*[:：]\\s*(.+?)(?=\\s+[\\u4e00-\\u9fa5A-Za-z]{2,8}\\s*[:：]|$)`
  )
  for (const l of lines) {
    const m = re.exec(l)
    if (m) {
      // m[2]：第 1 组来自 labelRe，第 2 组才是值
      const v = (m[2] ?? '').trim()
      if (v && v.length <= maxLen) return v
    }
  }
  return undefined
}

/** 工作年限 —— 支持 `工作2年` / `5年工作经验` / `工作年限：8 年` / `从业 6 年` */
export function extractYearsOfExperience(text: string): number | undefined {
  const patterns = [
    /工作年限\s*[:：]?\s*(\d{1,2})\s*年/,
    /(?:工作|从业|工龄|经验)\s*(\d{1,2})\s*年/,
    /(\d{1,2})\s*年\s*(?:以上)?\s*(?:工作)?经验/,
  ]
  for (const re of patterns) {
    const m = re.exec(text || '')
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 0 && n <= 50) return n
    }
  }
  return undefined
}

/** 期望薪资 —— 支持区间、单值×13薪、面议 */
export function extractSalary(text: string): string | undefined {
  const t = (text || '').replace(/\s/g, '')
  const rangeWithMonths = /(\d{1,3}[-~到]\d{1,3}[kK万])\s*[×x*]\s*(\d{1,2})薪/.exec(t)
  if (rangeWithMonths) return `${rangeWithMonths[1]}×${rangeWithMonths[2]}`
  const singleWithMonths = /(\d{1,3}[kK万])\s*[×x*]\s*(\d{1,2})薪/.exec(t)
  if (singleWithMonths) return `${singleWithMonths[1]}×${singleWithMonths[2]}`
  const range = /(\d{1,3}[-~到]\d{1,3}[kK万])/.exec(t)
  if (range) return range[1]
  const single = /(\d{2,3}[kK])(?![a-zA-Z0-9])/.exec(t)
  if (single) return single[1]
  if (/面议/.test(t)) return '面议'
  return undefined
}

const COMPANY_SUFFIX_RE =
  /(有限公司|股份有限公司|集团|研究院|研究所|科技|电子|半导体|光电|激光|智能|自动化)/
/** 这些开头的行不像「公司名一行」，更像段落（要排除） */
const PARAGRAPH_PREFIX =
  /^(工作背景|自我评价|个人优势|项目描述|工作内容|工作描述|职责|业绩|项目经历|工作经历|教育经历|求职意向)/

/**
 * 当前公司。三级：
 *   ① 头部显式标签（`当前公司：X`）—— 最可靠
 *   ② 头部里的短公司行（排除段落行）
 *   ③ 章节区（工作经历）里**第一段**的公司行 —— 简历通常倒序列出，第一条就是当前
 * 第 ③ 级是必要的：真实案例里「某某汽车线束有限公司」只出现在工作经历里，
 * 只看头部会把公司字段丢掉。
 */
export function extractCurrentCompany(header: string[], sections: string[]): string | undefined {
  const labeled = labeledValue(header, /(当前公司|所在公司|现公司|公司名称|就职于)/)
  if (labeled) return labeled

  for (const l of header) {
    if (l.length > 30) continue
    if (PARAGRAPH_PREFIX.test(l)) continue
    if (looksLikeChromeOrJunk(l)) continue
    if (COMPANY_SUFFIX_RE.test(l)) return l
  }

  for (const l of sections) {
    if (l.length > 30) continue
    if (PARAGRAPH_PREFIX.test(l)) continue
    if (COMPANY_SUFFIX_RE.test(l)) return l
  }
  return undefined
}

const TITLE_WORD_RE =
  /(工程师|经理|主管|总监|专员|设计师|研究员|架构师|顾问|负责人|组长|主任|总裁|总经理|助理)/
const TITLE_STOPWORDS = /(求职意向|期望职位|当前职位|职位|岗位|招聘|推荐职位)/

/** 当前职位：标签 → 头部短职位行 */
export function extractCurrentTitle(header: string[]): string | undefined {
  const labeled = labeledValue(header, /(当前职位|现任职位|职位|岗位)/)
  if (labeled) return labeled

  for (const l of header) {
    if (l.length > 24) continue
    if (TITLE_STOPWORDS.test(l)) continue
    if (looksLikeChromeOrJunk(l)) continue
    if (TITLE_WORD_RE.test(l)) return l
  }
  return undefined
}

/** 求职意向 */
export function extractIntention(header: string[], sections: string[]): string | undefined {
  const labeled = labeledValue([...header, ...sections], /(求职意向|期望职位|意向岗位|期望岗位)/)
  if (labeled) return labeled
  // 猎聘头部有「求职意向」独行，值在下一行
  for (let i = 0; i < header.length; i++) {
    if (/^(求职意向|期望职位)\s*[:：]?\s*$/.test(header[i])) {
      const next = header[i + 1]
      if (next && next.length <= 30 && TITLE_WORD_RE.test(next)) return next
    }
  }
  return undefined
}

/** 平台自己推荐的职位（猎聘头部的「推荐职位：项目经理」） */
export function extractRecommendedPosition(header: string[]): string | undefined {
  for (let i = 0; i < header.length; i++) {
    const m = /^推荐职位\s*[:：]\s*(.*)$/.exec(header[i])
    if (!m) continue
    const inline = m[1].trim()
    if (inline) return inline
    // 猎聘把这个值放在**下一行**
    const next = (header[i + 1] || '').trim()
    if (next && next.length <= 30 && !looksLikeChromeOrJunk(next)) return next
  }
  return undefined
}

/** 姓名里的性别线索（猎聘头部没有「性别：」标签，但会写「孙先生 / 李女士」） */
export function genderFromSalutation(name: string): 'M' | 'F' | undefined {
  if (/(先生|男士)$/.test(name || '')) return 'M'
  if (/(女士|小姐)$/.test(name || '')) return 'F'
  return undefined
}

export function extractGender(
  header: string[],
  sections: string[],
  name: string
): 'M' | 'F' | 'unknown' {
  const labeled = /性别\s*[:：]\s*(男|女)/.exec([...header, ...sections].join('\n'))
  if (labeled) return labeled[1] === '男' ? 'M' : 'F'

  const fromName = genderFromSalutation(name)
  if (fromName) return fromName

  for (const l of header.slice(0, 12)) {
    // 「男 · 28岁 · 深圳」这种紧凑行（用非汉字边界避免误伤含「男/女」的词）
    if (/(^|[^\u4e00-\u9fa5])男([^\u4e00-\u9fa5]|$)/.test(l)) return 'M'
    if (/(^|[^\u4e00-\u9fa5])女([^\u4e00-\u9fa5]|$)/.test(l)) return 'F'
  }
  return 'unknown'
}

/** 技能标签：用行业术语词典扫全文（零成本让技能云对真实数据也有内容） */
export function extractSkills(text: string, limit = 24): string[] {
  const hay = text || ''
  const lower = hay.toLowerCase()
  const out: string[] = []
  for (const t of SKILL_TERMS) {
    if (out.length >= limit) break
    if (/^[A-Za-z0-9+#. ]+$/.test(t)) {
      if (lower.includes(t.toLowerCase())) out.push(t)
    } else if (hay.includes(t)) {
      out.push(t)
    }
  }
  return out
}

// ------------------------------------------------------------ 总入口

/**
 * 简历原文的字段提取。
 *
 * 导出是为了让维护脚本（`scripts/repair-data.mjs`）能在规则改进后
 * 把已经入库的历史简历重跑一遍 —— **改好提取逻辑不会让已有数据自动变好**。
 */
export function parseResumeText(raw: string): Partial<Candidate> & { name: string } {
  const text = (raw || '').replace(/\r/g, '')
  const lines = cleanLines(text)
  const { header, sections } = splitResume(text)

  const out: Partial<Candidate> & { name: string } = { name: '' }

  // ---- 姓名（走共享的识别逻辑，会跳过「查看大图」这类面板按钮文案）
  // ⚠️ 兜底**不能**取第一行：采集容器的第一行经常是 UI 文案。
  //    真实事故：一份打码姓名 `王**` 的简历认不出姓名，结果姓名列被写成「快速定位：」。
  //    宁可写「未识别姓名」（一眼能看出没认出来），也不能把界面文案当人名。
  out.name = guessResumeName(text) || scanForNameLine(lines) || '未识别姓名'

  // ---- 手机号 / 邮箱
  // 猎聘头部给的是脱敏写法（138****0000），只有聊天区才可能有完整号码
  const compact = text.replace(/[-\s]/g, '')
  const phone = /1[3-9]\d{9}/.exec(compact) || /1[3-9][\d*＊]{9}/.exec(text)
  if (phone) {
    const digits = phone[0].replace(/\D/g, '')
    out.phone = digits.length === 11 ? digits.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : phone[0]
  }
  const mail = /[\w.+-]+@[\w-]+\.[\w.]+/.exec(text)
  if (mail) out.email = mail[0]

  // ---- 分隔符行（猎聘的学历行：一行出 学校/专业/学历/统招 四个字段）
  let sep: SeparatorFields | null = null
  for (const l of header) {
    const s = parseSeparatorLine(l)
    if (s) {
      sep = s
      break
    }
  }

  // ---- 学历
  const degreeLabeled = labeledValue(header, /(学历|最高学历)/, 12)
  if (degreeLabeled) {
    for (const r of DEGREE_RULES) {
      if (r.re.test(degreeLabeled)) {
        out.degree = r.value
        break
      }
    }
  }
  if (!out.degree) {
    if (sep?.degree) out.degree = sep.degree
    else {
      for (const r of DEGREE_RULES) {
        if (r.re.test(text)) {
          out.degree = r.value
          break
        }
      }
    }
  }

  // ---- 学历性质（统招 / 非统招）—— 猎聘已经写在学历行里了
  const modeLine = lines.find((l) => EDU_MODE_RE.test(l))
  const mode = normalizeEducationMode(sep?.educationMode || modeLine || '')
  if (mode) {
    out.educationMode = mode
    out.educationEvidence = (modeLine || '').slice(0, 80)
  }

  // ---- 学校 / 专业
  out.school = labeledValue(header, /(毕业院校|学校|院校|毕业于)/, 24) || sep?.school
  out.major = labeledValue(header, /(专业|所学专业)/, 24) || sep?.major
  if (!out.school) {
    for (const l of header) {
      if (l.length <= 24 && /^[\u4e00-\u9fa5]{2,18}(大学|学院|研究院)$/.test(l)) {
        out.school = l
        break
      }
    }
  }

  // ---- 院校层次
  const tier = schoolTierOf(text, out.school)
  if (tier) out.schoolTier = tier

  // ---- 城市
  const city = extractCity(header.length > 0 ? header : lines)
  if (city) out.city = city

  // ---- 年龄 / 工作年限
  const age = /(\d{2})\s*岁/.exec(text)
  if (age) out.age = Number(age[1])
  const yoe = extractYearsOfExperience(text)
  if (yoe !== undefined) out.yearsOfExperience = yoe

  // ---- 薪资
  const salary = extractSalary(text)
  if (salary) out.expectedSalary = salary

  // ---- 当前公司 / 职位 / 意向 / 平台推荐职位
  const company = extractCurrentCompany(header, sections)
  if (company) out.currentCompany = company
  const title = extractCurrentTitle(header)
  if (title) out.currentTitle = title
  const intention = extractIntention(header, sections)
  if (intention) out.intention = intention
  const recommended = extractRecommendedPosition(header)
  if (recommended) out.recommendedPosition = recommended

  // ---- 分节解析（给「意向职位 / 期望城市 / 语言」用）
  // 为什么要走分节而不是标签：真实猎聘格式里「求职意向」是一个**章节**
  // （下一行是「查看全部3个」，再下面才是职位），旧的 extractIntention 只认
  // 「求职意向：值」这种标签写法 —— 实测 5 条真实简历的 intention 全是空的。
  // 分节解析在真实数据上是好的（孙先生 → 项目经理/主管 + 6 个期望城市）。
  const sec = parseResumeSections(text)
  if (sec.intention) {
    if (sec.intention.positions.length > 0) {
      // 保持与种子数据一致的语义：intention = 意向职位
      out.intention = sec.intention.positions.join(' / ')
    }
    if (sec.intention.cities.length > 0) out.intentionCities = sec.intention.cities
  }
  if (sec.languages.length > 0) out.languages = sec.languages

  // ---- 性别（标签 → 称呼 → 紧凑行）
  out.gender = extractGender(header, sections, out.name)

  // ---- 平台简历编号（猎聘：`简历编号 : EF56AB78CD9000ee55ff66`）
  const no = extractResumeNo(text)
  if (no) out.resumeNo = no

  // ---- 技能标签（词典命中，不是模型抽取）
  out.skills = extractSkills(text)
  out.skillsSource = 'dictionary'

  return out
}

// ------------------------------------------------------------ 尾部 UI 噪声 / 易变行

/**
 * 简历正文里「尾部操作区」的起始标志。
 *
 * 真实数据（猎聘详情页，孙先生那份 6634 字）最后 19 行全是这类东西：
 *   觉得TA还不错：/ 获取电话 / 剩10次权益 / 意向沟通 / 立即沟通 / 超级聊聊 /
 *   免费权益，本月剩余30次 / 免费发起 / 保存 / 操作记录 / 收藏 / NEW / 转发 /
 *   打印 / 举报 / 人才招聘记录 / 该候选人无人才招聘记录 / 简历备注 / 暂无备注内容
 *
 * 两个害处：
 *   ① 排进 PDF 会印出「剩10次权益」，很不专业；
 *   ② **它会进内容指纹** —— `剩N次权益`、`本月剩余N次` 随账号权益余额变化，
 *      于是同一份简历隔几天再采，指纹就变了 → **又存一条重复档案**。
 * 所以必须在「算指纹之前」就切掉。
 */
const RESUME_FOOTER_MARKERS: RegExp[] = [
  /^觉得TA还不错/,
  /^获取电话$/,
  /^超级聊聊$/,
  /^操作记录$/,
  /^人才招聘记录$/,
  /^简历备注$/,
  // ⚠️ 这里**刻意不包含 `/^向TA索要/`** —— 它出现在「简历编号」**之前**，
  //    拿它当尾部起点会把平台给的简历编号一起切掉（真实数据里就这么丢过一次）。
  //    附件区本身由 parseResumeSections 的 DROP_SECTIONS 负责不印到 PDF 上。
]

/**
 * 剥掉正文尾部的操作区（从第一个尾部标志行开始整段丢弃）。
 * @param minIndex 只在「已经过了正文开头一部分」之后才切，避免误伤正文里恰好出现这些词的行
 */
export function stripResumeChrome(text: string, minIndex = 6): string {
  const src = (text || '').replace(/\r/g, '')
  const lines = src.split('\n')
  for (let i = Math.min(minIndex, lines.length); i < lines.length; i++) {
    const l = lines[i].trim()
    if (RESUME_FOOTER_MARKERS.some((re) => re.test(l))) {
      return lines.slice(0, i).join('\n').replace(/\n+$/, '')
    }
  }
  return src
}

/**
 * 「会随时间 / 账号状态变化」的行 —— 算指纹时必须抹掉。
 *
 * 为什么不塞进 `UI_CHROME_WORDS`：那份是**按钮文案的精确字符串表**（用 includes 匹配），
 * 而这里是**带数字的模式**（`剩10次权益` / `7天内活跃` / `更新简历时间：2026.07.20`），
 * 只能靠正则。这些行留在指纹里 = 同一份简历每次采集都算出一个新指纹。
 *
 * 注意：**刻意不包含 `简历编号`** —— 那是平台给的身份编号，
 * 留着反而能让同一人的两次采集算出同一个指纹。
 */
export const VOLATILE_LINE_RES: readonly RegExp[] = [
  /^【?(今天|昨天|昨日|最近|本周|本月|三天内|3天内|\d+天内)活跃】?$/,
  /^更新简历时间[:：]/,
  /^剩\s*\d+\s*次权益$/,
  /^本月剩余\s*\d+\s*次$/,
  /^免费权益/,
  /^该人选为行业高端人才/,
  /^(急需|太多人选)/,
]

/** 判断一行是不是「易变行」（算指纹时丢弃） */
export function isVolatileLine(line: string): boolean {
  const l = (line || '').trim()
  return VOLATILE_LINE_RES.some((re) => re.test(l))
}

/** 平台简历编号：猎聘写作 `简历编号 : EF56AB78CD9000ee55ff66`（值可能在同一行也可能在下一行） */
export function extractResumeNo(text: string): string | undefined {
  const lines = (text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    if (!/^简历编号/.test(lines[i])) continue
    const inline = /^简历编号\s*[:：]?\s*([A-Za-z0-9]{8,})/.exec(lines[i])
    if (inline) return inline[1]
    const next = (lines[i + 1] || '').replace(/^[:：]\s*/, '').trim()
    if (/^[A-Za-z0-9]{8,}$/.test(next)) return next
  }
  return undefined
}

// ------------------------------------------------------------ 结构化分节（给 PDF 排版用）

export type SectionConfidence = 'high' | 'medium' | 'low'

export interface ResumeExperience {
  company: string
  title?: string
  period?: string
  duration?: string
  bullets: string[]
}

export interface ResumeEducation {
  school: string
  degree?: string
  major?: string
  period?: string
  tier?: string
  mode?: string
}

export interface ResumeProject {
  name: string
  period?: string
  title?: string
  company?: string
  bullets: string[]
}

export interface ResumeIntention {
  positions: string[]
  salary?: string
  cities: string[]
  industries?: string[]
}

export interface ResumeSections {
  intention?: ResumeIntention
  experiences: ResumeExperience[]
  education: ResumeEducation[]
  projects: ResumeProject[]
  skills: string[]
  languages: string[]
  /**
   * 结构化置信度。
   *   high   = 命中了「块结束标记」，分块可靠
   *   medium = 只按章节切出来，块内字段靠模式推断
   *   low    = 连章节都没认出来，只能用原行
   * PDF 在 medium/low 时会**同时**按原文原样附一份，宁可朴素也不印错。
   */
  confidence: SectionConfidence
  /** 按章节切出的原始段落（永远填）—— 低置信度时就是 PDF 的正文来源 */
  blocks: Array<{ title: string; lines: string[] }>
}

/** 猎聘在每个经历/项目块的末尾都会写这一行 —— 绝好的切块锚点 */
const BLOCK_TERMINATOR = /^\*该段内容已整合附件简历信息$/

/** 我们认得的章节标题 */
const SECTION_TITLES = [
  '求职意向',
  '工作经历',
  '工作经验',
  '项目经历',
  '项目经验',
  '教育经历',
  '教育背景',
  '技能标签',
  '专业技能',
  '语言能力',
  '证书',
  '荣誉奖项',
  '自我评价',
  '附加信息',
  '附件简历与个人作品',
] as const

/** 尾部之后我们不再需要的章节（附件要索要才有，抓不到） */
const DROP_SECTIONS = new Set(['附件简历与个人作品', '简历编号', '操作记录'])

function headingOf(line: string): string | null {
  const l = line.trim()
  const bare = l.replace(/^【|】$/g, '')
  for (const t of SECTION_TITLES) {
    if (bare === t) return t
  }
  // 【工作经历】 这种也行
  const m = /^【(.+?)】$/.exec(l)
  if (m && SECTION_TITLES.includes(m[1] as (typeof SECTION_TITLES)[number])) return m[1]
  return null
}

function isPeriodLine(l: string): boolean {
  if (l.length > 40) return false
  if (!/(19|20)\d{2}\s*[./年-]\s*\d{1,2}/.test(l)) return false
  return /([-–~至到]|至今|现在|Present)/i.test(l) || /\((.*?)\)/.test(l) || l.length <= 18
}

function splitByTerminator(lines: string[]): { blocks: string[][]; usedTerminator: boolean } {
  const blocks: string[][] = []
  let cur: string[] = []
  let usedTerminator = false
  for (const l of lines) {
    if (BLOCK_TERMINATOR.test(l.trim())) {
      usedTerminator = true
      if (cur.some((x) => x.trim())) blocks.push(cur)
      cur = []
      continue
    }
    cur.push(l)
  }
  if (cur.some((x) => x.trim())) blocks.push(cur)
  return { blocks, usedTerminator }
}

/**
 * 没有块结束标记时，用「公司名行」当分块边界。
 *
 * 为什么需要它：猎聘详情页的经历段落**不写** `*该段内容已整合附件简历信息`，
 * 整段会被当成一段 —— 真实数据里周敏的 4 家公司（某某集团 / 某某半导体 /
 * 某某电子分厂 / 某某电子）就塌成了 1 条。
 *
 * 误判防护（宁可少切）：行要短（≤30 字）、含机构词、**不以数字/项目符号开头**、
 * **不以句读结尾**（描述句常以「，」「。」结尾，公司名不会）。
 */
function splitByCompanyLine(lines: string[]): string[][] {
  const blocks: string[][] = []
  let cur: string[] = []
  for (const l of lines) {
    const t = l.trim()
    const looksCompany =
      t.length > 0 &&
      t.length <= 30 &&
      !/^[\d•·\-*（(]/.test(t) &&
      !/[。，；：,;]$/.test(t) &&
      !NOT_COMPANY_LINE_RE.test(t) &&
      // 纯职位名（`网络工程师`）不是公司名 —— 除非它还带公司后缀
      !(TITLE_WORD_RE.test(t) && !COMPANY_SUFFIX_RE.test(t)) &&
      COMPANY_BOUNDARY_RE.test(t)
    if (looksCompany && cur.some((x) => x.trim())) {
      blocks.push(cur)
      cur = []
    }
    cur.push(l)
  }
  if (cur.some((x) => x.trim())) blocks.push(cur)
  return blocks
}

/**
 * 机构名特征词（用于「公司名行」分块边界）。
 *
 * ⚠️ 这里**刻意比 `COMPANY_SUFFIX_RE` 严格得多**：只保留强特征。
 *    早先用了宽表（含 `科技/电子/半导体/网络/汽车/能源`），结果
 *    **`网络工程师` 被判成一家公司**（含「网络」），李先生被切成 6 段、其中两段的
 *    公司名是「网络工程师」。教训：分块边界宁可少切，切错会污染整列数据。
 *    注意这里不需要覆盖「段落第一行是弱特征公司名」（如 `某某能源`）的情况 ——
 *    段落第一行天然就是块的开始，不需要它来当边界。
 */
const COMPANY_BOUNDARY_RE =
  /(有限公司|股份有限公司|有限责任公司|集团|研究院|研究所|设计院|事务所|银行|医院|学校|大学|工厂|分厂|制造厂|厂$|事业部|分行|支行)/

/** 这些词出现在「公司名候选行」里，说明它其实是描述句而不是公司名 */
const NOT_COMPANY_LINE_RE = /(毕业|就读|负责|参与|主导|完成|任职|任职于|担任|工作内容|主要职责)/

/** 语言白名单 —— `语言能力` 这一节常常一直延到正文末尾，混进按钮/附件信息 */
const LANGUAGE_WORDS = [
  '英语',
  '日语',
  '德语',
  '法语',
  '韩语',
  '俄语',
  '西班牙语',
  '葡萄牙语',
  '意大利语',
  '阿拉伯语',
  '泰语',
  '越南语',
  '印地语',
  '荷兰语',
  '瑞典语',
  '普通话',
  '粤语',
  '闽南语',
  '上海话',
  '客家话',
]

/**
 * 这一行是不是「语言」。
 *
 * 为什么必须用白名单而不是「取章节里所有行」：真实数据实测，
 * 张小雨的「语言」曾解析成
 *   ["英语(CET6、工作应用)", "日语(N3、基础沟通)", "德语(基础沟通)",
 *    "附件简历", "0.4MB", "预览", "下载", "简历编号", "投递时间: 2026.09.30", …]
 * —— 章节没在正确的地方结束，后面的附件区与按钮全掉进来了。
 * 白名单开头匹配可以带括号补充（`英语(CET6、工作应用)` 有信息量，保留）。
 */
function isLanguageLine(line: string): boolean {
  const t = line.trim()
  if (t.length === 0 || t.length > 30) return false
  if (/^\d/.test(t)) return false
  return LANGUAGE_WORDS.some((w) => t.startsWith(w))
}

function parseExperienceBlock(lines: string[]): ResumeExperience {
  const rest = lines.map((l) => l.trim()).filter(Boolean)
  const out: ResumeExperience = { company: '', bullets: [] }

  const ci = rest.findIndex((l) => COMPANY_SUFFIX_RE.test(l) && l.length <= 30)
  if (ci >= 0) out.company = rest.splice(ci, 1)[0]
  else if (rest.length > 0) {
    // 没有公司后缀时，用第一行当公司名 —— 但要挡住三类**明显不是公司名**的行：
    //   ① 职位名（真实数据里「网络工程师」曾被当成一家公司）
    //   ② 项目符号行（`1. 主导晶圆表面缺陷检测…`）—— 非结构化的「工作经历」
    //      常常就是一串编号条目，早先会把第 1 条当成公司名，导出的「经历」列
    //      变成一句描述，整列数据就废了
    //   ③ 以句读结尾的描述句
    const first = rest[0]
    const bulletLike = /^\s*(\d+\s*[.、)）]|[•·\-*]|\(\d+\))/.test(first)
    const titleLike = TITLE_WORD_RE.test(first) && !COMPANY_SUFFIX_RE.test(first)
    const sentenceLike = /[。，；：,;]$/.test(first) || first.length > 24
    if (!titleLike && !bulletLike && !sentenceLike) out.company = rest.shift() as string
  }

  const pi = rest.findIndex(isPeriodLine)
  if (pi >= 0) {
    const p = rest.splice(pi, 1)[0]
    const m = /\(([^)]*)\)/.exec(p)
    if (m) out.duration = m[1].trim()
    out.period = p.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  }

  const ti = rest.findIndex(
    (l) => l.length <= 24 && TITLE_WORD_RE.test(l) && !/^(描述|职责|工作内容|工作描述|主要职责)[:：]?$/.test(l)
  )
  if (ti >= 0) {
    // 猎聘常把薪资粘在职位后面（`工艺助理工程师7k×13薪`）—— 剥掉尾巴
    out.title = rest.splice(ti, 1)[0].replace(/\s*\d+(?:\.\d+)?\s*[kK](?:\s*×\s*\d+\s*薪?)?\s*$/, '').trim()
  }

  out.bullets = rest
  return out
}

function parseEducationBlock(lines: string[]): ResumeEducation | null {
  const rest = lines.map((l) => l.trim()).filter(Boolean)
  if (rest.length === 0) return null
  const out: ResumeEducation = { school: '' }

  // ① 先吃「分隔符行」—— 猎聘同一所学校有两种写法：
  //      完整版：`河北工业大学 · 土木工程 · 本科 · 统招`（一行四字段）
  //      紧凑版：学校单独一行，下一行是 `本科 · 土木工程`
  //    不先吃它的话，紧凑版的「本科 · 土木工程」会被判成「学位行」而整行丢掉，
  //    于是专业为空（真实数据里就这样丢过）。
  for (const l of [...rest]) {
    const sep = parseSeparatorLine(l)
    if (!sep) continue
    if (sep.school && !out.school) out.school = sep.school
    if (sep.degree && !out.degree) out.degree = sep.degree
    if (sep.major && !out.major) out.major = sep.major
    if (sep.educationMode && !out.mode) out.mode = sep.educationMode
    rest.splice(rest.indexOf(l), 1)
  }

  const SCHOOL_RE = /(大学|学院|研究院|学校|职业学院)/
  if (!out.school) {
    const si = rest.findIndex((l) => SCHOOL_RE.test(l) && l.length <= 24 && !/^\d/.test(l))
    if (si >= 0) out.school = rest.splice(si, 1)[0]
  }
  if (!out.school) return null

  const tier = rest.find((l) => /^(985|211|双一流)$/.test(l))
  if (tier && !out.tier) out.tier = tier

  const pi = rest.findIndex(isPeriodLine)
  if (pi >= 0) out.period = rest.splice(pi, 1)[0].replace(/\s*\([^)]*\)\s*/g, ' ').trim()

  if (!out.degree) {
    for (const r of [...rest]) {
      for (const d of DEGREE_RULES) {
        if (d.re.test(r) && r.length <= 10) {
          out.degree = d.value
          break
        }
      }
      if (out.degree) break
    }
  }
  if (!out.mode) out.mode = normalizeEducationMode(rest.join(' ')) || undefined

  // 专业 = 去掉学历词/统招词/层次标签之后的剩余中文段（取最长的那个）
  if (!out.major) {
    const major = rest
      .filter(
        (r) =>
          !isDegreeToken(r) &&
          !EDU_MODE_RE.test(r) &&
          !/^(985|211|双一流)$/.test(r) &&
          /^[\u4e00-\u9fa5A-Za-z（）()·\-]{2,20}$/.test(r)
      )
      .sort((a, b) => b.length - a.length)[0]
    if (major) out.major = major
  }
  return out
}

function parseProjectBlock(lines: string[]): ResumeProject {
  const rest = lines.map((l) => l.trim()).filter(Boolean)
  const out: ResumeProject = { name: '', bullets: [] }
  if (rest.length === 0) return out
  out.name = rest.shift() as string

  const pi = rest.findIndex(isPeriodLine)
  if (pi >= 0) {
    const p = rest.splice(pi, 1)[0]
    out.period = p.replace(/\s*\([^)]*\)\s*/g, ' ').trim()
  }
  const ci = rest.findIndex((l) => COMPANY_SUFFIX_RE.test(l) && l.length <= 30)
  if (ci >= 0) out.company = rest.splice(ci, 1)[0]
  const ti = rest.findIndex((l) => l.length <= 24 && TITLE_WORD_RE.test(l))
  if (ti >= 0) out.title = rest.splice(ti, 1)[0]
  out.bullets = rest
  return out
}

function parseIntentionBlock(lines: string[]): ResumeIntention {
  const rest = lines
    .map((l) => l.trim())
    .filter((l) => l && !/^查看全部\d+个$/.test(l) && l !== '全部行业')
  const out: ResumeIntention = { positions: [], cities: [] }

  // 猎聘的版式是固定的：职位 / 薪资 / 城市 / 行业。
  // 所以按「职责」归类比按位置猜更准 —— 尤其别把行业当职位
  // （真实数据里 `整车制造`、`新能源汽车` 曾被当成第二个、第三个职位）。
  for (const l of rest) {
    const s = extractSalary(l)
    if (s && l.replace(/\s/g, '').length <= 14) {
      out.salary = out.salary ?? s
      continue
    }
    if (/\d/.test(l) && !TITLE_WORD_RE.test(l)) continue // 其余带数字的多半是年限/福利，丢掉

    const cityParts = l.split(/[、,，]/).map((c) => c.trim())
    if (cityParts.length > 0 && cityParts.every((c) => CITY_LIST.includes(c))) {
      out.cities.push(...cityParts)
      continue
    }
    if (out.positions.length === 0) {
      out.positions.push(l)
      continue
    }
    if (l.length <= 24 && TITLE_WORD_RE.test(l)) {
      out.positions.push(l)
      continue
    }
    out.industries = out.industries ?? []
    if (out.industries.length < 4) out.industries.push(l)
  }
  return out
}

/**
 * 把采集到的简历正文解析成结构化分节（给 PDF 排版用）。
 *
 * 分四层降级，**永不「解析失败就空白」**：
 *   ① 块结束标记 `*该段内容已整合附件简历信息` → 切块（高置信）
 *   ② 章节词定位后，块内按「公司 / 职位 / 时间 / 描述」模式推断（中）
 *   ③ 只有章节词、块内认不出结构 → 段落原样保留（中低）
 *   ④ 连章节都没有 → 按原行输出（低）
 */
export function parseResumeSections(text: string): ResumeSections {
  const cleaned = stripResumeChrome(text || '')
  const lines = cleanLines(cleaned)

  // ---- 1. 按章节标题切段（同名章节合并 —— 猎聘的「教育经历」会出现两次）
  const order: string[] = []
  const map = new Map<string, string[]>()
  let curTitle = '基本信息'
  order.push(curTitle)
  map.set(curTitle, [])
  for (const l of lines) {
    const h = headingOf(l)
    if (h) {
      if (DROP_SECTIONS.has(h)) break // 尾部之后的都不要
      curTitle = h
      if (!map.has(h)) {
        map.set(h, [])
        order.push(h)
      }
      continue
    }
    map.get(curTitle)?.push(l)
  }

  const blocks = order
    .map((title) => ({ title, lines: (map.get(title) ?? []).filter(Boolean) }))
    .filter((b) => b.lines.length > 0)

  const hasExperienceSection = order.some((t) => t === '工作经历' || t === '工作经验')
  const hasStructure = hasExperienceSection || order.includes('教育经历') || order.includes('教育背景')

  // ---- 2. 逐段解析
  const out: ResumeSections = {
    experiences: [],
    education: [],
    projects: [],
    skills: [],
    languages: [],
    confidence: hasStructure ? 'medium' : 'low',
    blocks,
  }

  let anyTerminator = false

  for (const title of order) {
    const seg = (map.get(title) ?? []).filter(Boolean)
    if (seg.length === 0) continue

    if (title === '求职意向') {
      out.intention = parseIntentionBlock(seg)
    } else if (title === '工作经历' || title === '工作经验') {
      const { blocks: bs, usedTerminator } = splitByTerminator(seg)
      if (usedTerminator) anyTerminator = true
      // ⚠️ 真实数据有两种格式：猎聘**预览面板**每段结尾有 `*该段内容已整合附件简历信息`，
      //    而猎聘**详情页**完全没有这个标记 —— 那时整段会被当成 1 段（周敏 4 家公司塌成 1 条）。
      //    所以没有标记时改用「公司名行」当分块边界。
      const list = !usedTerminator && bs.length === 1 ? splitByCompanyLine(seg) : bs
      for (const b of list) {
        const e = parseExperienceBlock(b)
        // 公司名认不出来时也别整块丢掉 —— 至少还能留下职位与描述
        if (e.company || e.title) out.experiences.push(e)
      }
    } else if (title === '项目经历' || title === '项目经验') {
      const { blocks: bs, usedTerminator } = splitByTerminator(seg)
      if (usedTerminator) anyTerminator = true
      for (const b of bs) {
        const p = parseProjectBlock(b)
        if (p.name) out.projects.push(p)
      }
    } else if (title === '教育经历' || title === '教育背景') {
      const { blocks: bs } = splitByTerminator(seg)
      const list = bs.length > 1 ? bs : [seg]
      for (const b of list) {
        const e = parseEducationBlock(b)
        if (e) out.education.push(e)
      }
    } else if (title === '技能标签' || title === '专业技能') {
      out.skills.push(...seg.filter((l) => l.length <= 24))
    } else if (title === '语言能力') {
      out.languages.push(...seg.filter(isLanguageLine).slice(0, 6))
    }
  }

  // 教育经历去重：猎聘同一所学校会出现两次（一次是紧凑版、一次是完整版）。
  // ⚠️ 必须**逐字段取更全的那个**，不能「保留先出现的」——
  //    紧凑版往往缺专业/层次/统招，先出现的恰恰是信息更少的那条。
  const bySchool = new Map<string, ResumeEducation>()
  for (const e of out.education) {
    const cur = bySchool.get(e.school)
    if (!cur) {
      bySchool.set(e.school, { ...e })
      continue
    }
    bySchool.set(e.school, {
      school: e.school,
      degree: cur.degree || e.degree,
      major: cur.major || e.major,
      period: cur.period || e.period,
      tier: cur.tier || e.tier,
      mode: cur.mode || e.mode,
    })
  }
  out.education = [...bySchool.values()]
  out.skills = [...new Set(out.skills)]
  out.languages = [...new Set(out.languages)]

  if (anyTerminator) out.confidence = 'high'
  return out
}
