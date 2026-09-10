/**
 * 文档模板。
 *
 * 一份模板同时约束两件事：**大纲必须包含哪些节**，以及**每节该怎么写**。
 * 做成可序列化的数据而不是代码，是为了将来能支持「给一份样例文件，自动学出格式」——
 * 但那不在本次范围，所以先内置三份。
 *
 * 「固定节」必须存在且唯一；「可展开节」会在该位置按主题地图展开若干节
 * （讲义的分章、综述的分析章节都是这种）。
 */

/** 模板里的一个位置。 */
export interface TemplateSlot {
  readonly key: string
  /** 固定节用这个标题；可展开节用它作为大类名。 */
  readonly heading: string
  /** 这一节要回答什么。 */
  readonly goal: string
  readonly kind: 'fixed' | 'expandable'
  /** 写作提示（长度、要素、语气）。 */
  readonly hints?: readonly string[]
}

/** 一份文档模板。 */
export interface DocumentTemplate {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly slots: readonly TemplateSlot[]
  /** 整篇的写作要求。 */
  readonly writingGuidance: string
  /** 可展开节最少展开几节。 */
  readonly minExpandedSections: number
}

/** 讲义。 */
const lecture: DocumentTemplate = {
  id: 'lecture',
  title: '讲义',
  description: '面向学习者的教学材料：先给学习目标，再分章讲解，配例题与练习。',
  minExpandedSections: 2,
  writingGuidance: [
    '这是一份讲义，读者是要学会这个主题的人，不是要评估它的决策者。',
    '语言要清楚、循序渐进：先建立概念，再讲机制，最后讲限制与常见误解。',
    '每一节都要有实质内容，不要写「如上所述」「详见前文」这类空话。',
    '所有事实性陈述必须能在给定来源里找到依据；不确定的地方要明说不确定。',
  ].join('\n'),
  slots: [
    {
      key: 'objectives',
      heading: '学习目标',
      goal: '读完这份讲义，读者应该能做什么、理解什么',
      kind: 'fixed',
      hints: ['3–6 条，每条一句话，用「能够……」的句式', '不要写「了解」「熟悉」这类无法验证的目标'],
    },
    {
      key: 'body',
      heading: '正文',
      goal: '按主题逐章讲解',
      kind: 'expandable',
      hints: ['每一章聚焦话题的一个方面', '先讲清是什么，再讲为什么与怎么做', '关键处给出具体例子'],
    },
    {
      key: 'examples',
      heading: '例题',
      goal: '用具体例子演示正文里的方法',
      kind: 'fixed',
      hints: ['2–4 道，题目与解答分开写', '解答必须能独立看懂'],
    },
    {
      key: 'exercises',
      heading: '练习',
      goal: '让读者自己动手检验理解',
      kind: 'fixed',
      hints: ['4–6 道，由易到难', '只给题目，不要给答案'],
    },
    {
      key: 'summary',
      heading: '小结',
      goal: '收束全文，指出下一步该学什么',
      kind: 'fixed',
      hints: ['回顾核心结论', '诚实指出本讲义没有覆盖的部分'],
    },
  ],
}

/** 综述报告。 */
const report: DocumentTemplate = {
  id: 'report',
  title: '综述报告',
  description: '围绕一个问题梳理现状、分歧与结论的调研报告。',
  minExpandedSections: 2,
  writingGuidance: [
    '这是一份调研报告，读者要据此做判断。',
    '区分「有来源支持的事实」与「推断」；推断要显式标注。',
    '遇到来源之间说法不一致时，把分歧写出来，不要假装一致。',
    '不要为了行文顺畅而编造过渡性的因果解释。',
  ].join('\n'),
  slots: [
    { key: 'abstract', heading: '摘要', goal: '一屏之内说清这份报告发现了什么', kind: 'fixed', hints: ['3–5 句', '包含最重要的结论'] },
    { key: 'background', heading: '背景', goal: '这个问题为什么重要、边界在哪', kind: 'fixed', hints: ['交代术语与范围', '不要写成百科词条'] },
    { key: 'body', heading: '现状与分析', goal: '按方面展开分析', kind: 'expandable', hints: ['每个方面给出证据与来源', '指出证据的强度与局限'] },
    { key: 'conclusion', heading: '结论', goal: '给出可行动的判断', kind: 'fixed', hints: ['明确区分「已知」「推断」「未知」', '指出还需要什么信息才能下更确定的结论'] },
  ],
}

/** 简报。 */
const brief: DocumentTemplate = {
  id: 'brief',
  title: '简报',
  description: '给决策者的短材料：要点先行，建议明确。',
  minExpandedSections: 1,
  writingGuidance: [
    '这是一份简报，读者时间很少。',
    '结论先行，细节在后；能用一句话说清就不要写一段。',
    '每条建议都要说清「做什么」与「代价是什么」。',
  ].join('\n'),
  slots: [
    { key: 'summary', heading: '摘要', goal: '三句话讲完', kind: 'fixed', hints: ['不超过三句'] },
    { key: 'points', heading: '要点', goal: '支撑结论的关键事实', kind: 'expandable', hints: ['每条一句话加一个来源', '按重要性排序'] },
    { key: 'advice', heading: '建议', goal: '接下来该做什么', kind: 'fixed', hints: ['2–4 条', '每条注明代价或不确定性'] },
  ],
}

/** 全部内置模板。 */
export const BUILT_IN_TEMPLATES: readonly DocumentTemplate[] = [lecture, report, brief]

/** 默认模板。 */
export const DEFAULT_TEMPLATE_ID = report.id

/** 按 id 取模板；找不到时回退到默认模板而不是报错——写出一份通用报告，总好过什么都不写。 */
export function templateById(id: string | undefined): DocumentTemplate {
  if (id === undefined) return BUILT_IN_TEMPLATES.find((item) => item.id === DEFAULT_TEMPLATE_ID) as DocumentTemplate
  return BUILT_IN_TEMPLATES.find((item) => item.id === id)
    ?? (BUILT_IN_TEMPLATES.find((item) => item.id === DEFAULT_TEMPLATE_ID) as DocumentTemplate)
}

/** 固定节。 */
export function fixedSlots(template: DocumentTemplate): readonly TemplateSlot[] {
  return template.slots.filter((slot) => slot.kind === 'fixed')
}

/** 可展开节。 */
export function expandableSlots(template: DocumentTemplate): readonly TemplateSlot[] {
  return template.slots.filter((slot) => slot.kind === 'expandable')
}
