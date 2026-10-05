// ============================================================
// 示例数据（测试用）：5 个岗位 + 22 份候选人简历
// ------------------------------------------------------------
// 用途：在接上真实的浏览器扩展与大模型之前，先把「采集 → 归档 → 匹配 → 看板」
//       这条链路跑通，让界面有真实感的数据可看可筛可点。
// 数据背景：半导体量检测 / 面板检测 / 工业视觉缺陷检测方向。
// 清空方式：删除数据目录后重启（首次启动会自动重新灌入），
//           或在看板上点「重置示例数据」。
// ============================================================
import type {
  ApplicationStatus,
  Candidate,
  CandidateSource,
  Match,
  Platform,
  Position,
} from '@ria/shared'

export interface SeedDatabase {
  version: number
  candidates: Candidate[]
  positions: Position[]
  matches: Match[]
  sources: CandidateSource[]
}

// ------------------------------------------------------------
// 岗位
// ------------------------------------------------------------
const POSITIONS: Position[] = [
  {
    id: 'pos_vision',
    title: '高级视觉算法工程师（缺陷检测）',
    department: '算法部',
    city: '深圳',
    headcount: 2,
    jdText:
      '负责半导体 / 面板量检测设备的缺陷检测算法研发：从光学成像方案评估、图像预处理、缺陷分割与分类，到算法在设备上的工程化落地与量产稳定性调优。需要与光学、机械、软件团队协同，对检测灵敏度、过杀率、节拍负责。',
    hardRequirements: [
      '硕士及以上，计算机 / 自动化 / 光学工程相关专业',
      '5 年以上工业视觉缺陷检测算法经验',
      '精通 OpenCV / Halcon，具备 C++ 工程化落地能力',
      '有半导体、面板或 3C 检测设备量产项目经验',
    ],
    niceToHave: [
      '深度学习缺陷检测（分割 / 异常检测）落地经验',
      '熟悉 AOI / 量测设备的光学成像原理',
      '有发明专利或顶会论文',
    ],
    status: 'open',
    createdAt: '',
  },
  {
    id: 'pos_dl',
    title: '深度学习算法工程师（工业检测）',
    department: '算法部',
    city: '深圳',
    headcount: 3,
    jdText:
      '负责工业检测场景的深度学习模型研发与落地：缺陷分类 / 分割 / 异常检测、小样本学习、模型压缩与推理加速。需要把模型从实验推进到产线，对模型精度、推理耗时与稳定性负责。',
    hardRequirements: [
      '硕士及以上，人工智能 / 计算机相关专业',
      '3 年以上计算机视觉深度学习工程经验',
      '熟练 PyTorch，能独立完成从数据处理到模型部署的全流程',
      '有缺陷检测 / 分类 / 分割类项目落地经验',
    ],
    niceToHave: [
      '模型量化与推理加速（TensorRT / ONNX Runtime）',
      '小样本 / 无监督异常检测经验',
      '半导体或面板行业背景',
    ],
    status: 'open',
    createdAt: '',
  },
  {
    id: 'pos_cpp',
    title: 'C++ 软件工程师（设备控制软件）',
    department: '软件部',
    city: '深圳',
    headcount: 2,
    jdText:
      '负责量检测设备上位机软件的架构设计与开发：设备控制、运动控制、图像采集链路、通信协议、界面与数据管理。需要与算法、电气、机构团队配合完成设备联调与现场交付。',
    hardRequirements: [
      '本科及以上，计算机 / 自动化 / 机械电子相关专业',
      '5 年以上 C++ 上位机或设备控制软件经验',
      '熟悉多线程、网络通信（TCP / EtherCAT / Modbus）',
      '有运动控制或精密设备项目经验',
    ],
    niceToHave: ['Qt 界面开发经验', '了解半导体设备 SEMI 标准', '具备 Python 脚本能力'],
    status: 'open',
    createdAt: '',
  },
  {
    id: 'pos_optic',
    title: '光学工程师（量测设备）',
    department: '光学部',
    city: '上海',
    headcount: 1,
    jdText:
      '负责量测设备的光学系统设计：成像方案选型、光路设计与仿真、照明设计、公差分析，并参与光学装调与成像质量调优。需要与算法团队共同定义成像指标。',
    hardRequirements: [
      '硕士及以上，光学工程 / 光电信息相关专业',
      '3 年以上精密光学系统设计经验',
      '熟练使用 Zemax / Code V 进行光路设计与仿真',
      '有显微成像或干涉量测系统经验',
    ],
    niceToHave: ['熟悉偏振 / 干涉 / 共聚焦成像原理', '有半导体量测设备经验', '了解光学装调工艺'],
    status: 'open',
    createdAt: '',
  },
  {
    id: 'pos_fae',
    title: '应用工程师 / FAE（客户现场）',
    department: '应用部',
    city: '深圳',
    headcount: 1,
    jdText:
      '负责设备在客户现场的导入、调试与工艺优化：收集客户需求与缺陷样本、协助算法团队复现问题、输出应用报告。需要长期驻场或出差。',
    hardRequirements: [
      '本科及以上，工科背景',
      '3 年以上半导体或面板设备现场经验',
      '沟通表达能力强，可接受出差',
      '具备基本脚本能力（Python / Shell）',
    ],
    niceToHave: ['英文可作为工作语言', '有 AOI / 量测设备调试经验', '了解良率分析方法'],
    status: 'paused',
    createdAt: '',
  },
]

// ------------------------------------------------------------
// 候选人（紧凑定义，便于人工增删改）
// ------------------------------------------------------------
interface Spec {
  name: string
  gender: 'M' | 'F'
  age: number
  city: string
  degree: string
  school: string
  major: string
  yoe: number
  company: string
  title: string
  salary: string
  intention: string
  skills: string[]
  /** 工作经历要点，写入简历正文 */
  highlights: string[]
  /** 关联岗位 */
  position: string
  score: number
  status: ApplicationStatus
  hitPoints: string[]
  missPoints: string[]
  platform: Platform
  /** 采集于几天前 */
  daysAgo: number
}

const SPECS: Spec[] = [
  {
    name: '陈亦舟',
    gender: 'M',
    age: 33,
    city: '深圳',
    degree: '硕士',
    school: '华中科技大学',
    major: '光学工程',
    yoe: 8,
    company: '中科飞测',
    title: '资深算法工程师',
    salary: '60-80k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'C++', 'OpenCV', 'Halcon', 'PyTorch', '缺陷检测', 'AOI', '晶圆检测', '图像分割'],
    highlights: [
      '主导晶圆表面缺陷检测算法开发，覆盖明场 / 暗场两种成像模式，缺陷检出率从 92% 提升至 97.5%',
      '负责过杀率优化专项，通过多尺度特征融合与置信度校准，将过杀率从 3.1% 降至 0.8%',
      '牵头算法在设备端的工程化落地与量产爬坡，累计支持 30+ 台设备交付',
    ],
    position: 'pos_vision',
    score: 92,
    status: 'interview',
    hitPoints: [
      '硕士 / 光学工程，专业对口',
      '8 年工业视觉缺陷检测经验，超出 5 年要求',
      'OpenCV + Halcon + C++ 工程化能力齐全',
      '有半导体量测设备量产交付经验',
      '明暗场多模式成像缺陷检测实战',
    ],
    missPoints: ['团队管理经验未体现（该岗位暂不强要求）', '未体现专利 / 论文产出'],
    platform: 'boss',
    daysAgo: 1,
  },
  {
    name: '苏启明',
    gender: 'M',
    age: 35,
    city: '上海',
    degree: '博士',
    school: '上海交通大学',
    major: '模式识别与智能系统',
    yoe: 7,
    company: '天准科技',
    title: '高级算法工程师',
    salary: '70-90k',
    intention: '深度学习算法工程师（工业检测）',
    skills: ['PyTorch', 'ONNX', 'TensorRT', '缺陷分割', '异常检测', '小样本学习', '语义分割', '边缘检测'],
    highlights: [
      '负责面板缺陷检测模型全流程研发，语义分割方案把微小缺陷漏检率降低 40%',
      '自研无监督异常检测框架，在样本量 < 50 的新缺陷类型上达到 94% 召回',
      '主导模型量化与 TensorRT 部署，单张推理耗时从 180ms 降到 27ms',
    ],
    position: 'pos_dl',
    score: 90,
    status: 'screening',
    hitPoints: [
      '博士 / 模式识别，学术背景强',
      '7 年 CV 深度学习工程经验',
      '缺陷分割 + 异常检测双重落地经验',
      'TensorRT 量化部署能力，命中加分项',
      '小样本学习经验，命中加分项',
    ],
    missPoints: ['期望薪资 70-90k 高于该岗位预算上限', '主要在面板行业，半导体经验相对偏少'],
    platform: 'boss',
    daysAgo: 2,
  },
  {
    name: '吴嘉禾',
    gender: 'F',
    age: 32,
    city: '上海',
    degree: '硕士',
    school: '清华大学',
    major: '精密仪器与机械',
    yoe: 6,
    company: '上海微电子装备',
    title: '光学设计工程师',
    salary: '55-70k',
    intention: '光学工程师（量测设备）',
    skills: ['Zemax', 'Code V', 'LightTools', '光路设计', '公差分析', '显微成像', '干涉量测', '偏振光学'],
    highlights: [
      '负责量测模块照明与成像光路设计，NA 0.7 显微物镜成像 MTF 达设计要求 1.1 倍余量',
      '完成干涉量测系统光路搭建与像差校正，重复性精度优于 5nm',
      '主导光学装调工艺文件编写，支撑 10+ 台设备光学装配与验收',
    ],
    position: 'pos_optic',
    score: 93,
    status: 'screening',
    hitPoints: [
      '清华精密仪器硕士，专业高度对口',
      'Zemax / Code V 光路设计能力扎实',
      '显微成像 + 干涉量测双经验，命中加分项',
      '半导体设备（光刻）背景',
      '具备装调工艺经验，命中加分项',
    ],
    missPoints: ['无 Zemax 与实机装配之间的跨部门协同描述', '尚未体现团队带教经历'],
    platform: 'liepin',
    daysAgo: 3,
  },
  {
    name: '费宸',
    gender: 'M',
    age: 31,
    city: '深圳',
    degree: '博士',
    school: '中国科学技术大学',
    major: '计算机视觉',
    yoe: 4,
    company: '华为（2012 实验室）',
    title: '高级算法研究员',
    salary: '80-110k',
    intention: '深度学习算法工程师（工业检测）',
    skills: ['PyTorch', 'Transformer', '自监督学习', '异常检测', 'CUDA', '模型压缩', '目标检测'],
    highlights: [
      '从事工业质检方向的视觉算法预研，主导 2 个自监督预训练方案在产线落地',
      '发表 CVPR 论文 2 篇、申请专利 3 项',
      '负责模型压缩工具链，端侧推理吞吐提升 3.4 倍',
    ],
    position: 'pos_dl',
    score: 91,
    status: 'contacted',
    hitPoints: [
      '博士 / 计算机视觉，学术能力突出',
      '自监督 + 异常检测方向与岗位高度匹配',
      '有专利与顶会论文，命中加分项',
      '模型压缩与加速能力扎实',
    ],
    missPoints: ['4 年经验略低于团队期望的 5 年', '薪资期望 80-110k 明显超出预算', '缺少设备端量产交付经历'],
    platform: 'liepin',
    daysAgo: 5,
  },
  {
    name: '林知微',
    gender: 'F',
    age: 30,
    city: '深圳',
    degree: '硕士',
    school: '浙江大学',
    major: '计算机科学与技术',
    yoe: 6,
    company: '精测电子',
    title: '算法工程师',
    salary: '55-70k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'C++', 'OpenCV', '缺陷分类', '深度学习', '图像增强', 'AOI'],
    highlights: [
      '负责面板缺陷分类算法，16 类缺陷平均准确率 96.2%',
      '搭建缺陷样本管理系统与数据回流闭环，样本库从 3 万扩张到 40 万',
      '参与 AOI 设备算法现场调优，支撑产线稼动率提升 6 个百分点',
    ],
    position: 'pos_vision',
    score: 88,
    status: 'offer',
    hitPoints: [
      '硕士 / 计算机，专业对口',
      '6 年工业视觉经验',
      'OpenCV + C++ 工程化能力',
      '面板检测设备项目经验',
      '有数据闭环体系建设经验',
    ],
    missPoints: ['半导体晶圆检测经验偏少，主要在面板', 'Halcon 使用经验未体现'],
    platform: 'liepin',
    daysAgo: 9,
  },
  {
    name: '郑柏川',
    gender: 'M',
    age: 34,
    city: '深圳',
    degree: '本科',
    school: '电子科技大学',
    major: '软件工程',
    yoe: 9,
    company: '大族激光',
    title: '高级软件工程师',
    salary: '50-65k',
    intention: 'C++ 软件工程师（设备控制软件）',
    skills: ['C++', 'Qt', '多线程', 'EtherCAT', 'TCP/IP', '运动控制', '图像采集', 'CMake'],
    highlights: [
      '独立负责激光加工设备上位机软件架构，单机管理 12 轴运动控制与 3 路图像采集',
      '基于 EtherCAT 实现运动控制实时链路，控制周期稳定在 1ms',
      '牵头软件模块化重构，现场问题定位时间从 2 天缩短到 4 小时',
    ],
    position: 'pos_cpp',
    score: 89,
    status: 'interview',
    hitPoints: [
      '9 年 C++ 设备软件经验，超出 5 年要求',
      'EtherCAT + 多线程 + 运动控制全命中硬性条件',
      'Qt 界面开发，命中加分项',
      '有精密设备交付经验',
    ],
    missPoints: ['学历为本科，若团队要求硕士需特批', '半导体 SEMI 标准不了解'],
    platform: 'boss',
    daysAgo: 4,
  },
  {
    name: '罗清越',
    gender: 'F',
    age: 32,
    city: '深圳',
    degree: '硕士',
    school: '哈尔滨工业大学',
    major: '计算机应用技术',
    yoe: 7,
    company: '舜宇光学',
    title: '算法工程师',
    salary: '55-70k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'C++', 'Halcon', 'OpenCV', '表面缺陷检测', '图像配准', '亚像素测量'],
    highlights: [
      '负责光学镜片表面缺陷检测，实现亚像素级缺陷定位，最小检出尺寸 8μm',
      '设计多工位图像配准方案，解决镜片姿态变化导致的漏检问题',
      '算法在 3 条产线部署，年节省人工目检成本约 200 万元',
    ],
    position: 'pos_vision',
    score: 87,
    status: 'interview',
    hitPoints: [
      '硕士 / 计算机对口，7 年经验',
      'Halcon + OpenCV + C++ 齐全',
      '亚像素级缺陷检测与配准实战',
      '有量产产线部署经验',
    ],
    missPoints: ['检测对象为光学元件而非晶圆 / 面板', '未见深度学习方案落地描述'],
    platform: 'liepin',
    daysAgo: 6,
  },
  {
    name: '温子豪',
    gender: 'M',
    age: 29,
    city: '深圳',
    degree: '硕士',
    school: '西安电子科技大学',
    major: '计算机技术',
    yoe: 5,
    company: '海康机器人',
    title: '算法工程师',
    salary: '50-65k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'C++', 'OpenCV', 'PyTorch', '缺陷检测', '目标检测', '工业相机标定'],
    highlights: [
      '负责 3C 结构件外观缺陷检测，涵盖划伤 / 毛刺 / 漏镀等 11 类缺陷',
      '完成相机标定与光源方案评估，将成像一致性波动控制在 3% 以内',
      '主导算法在 20+ 台设备上线，单站节拍 1.8s',
    ],
    position: 'pos_vision',
    score: 85,
    status: 'screening',
    hitPoints: [
      '硕士 / 计算机，5 年经验正好达标',
      'OpenCV + C++ + PyTorch 组合完整',
      '相机标定与光源方案评估经验',
      '有多台设备上线经验',
    ],
    missPoints: ['3C 结构件为主，半导体 / 面板经验缺失', 'Halcon 未提及'],
    platform: 'liepin',
    daysAgo: 7,
  },
  {
    name: '徐立冬',
    gender: 'M',
    age: 36,
    city: '深圳',
    degree: '本科',
    school: '桂林电子科技大学',
    major: '计算机科学与技术',
    yoe: 10,
    company: '劲拓股份',
    title: '高级软件工程师',
    salary: '45-60k',
    intention: 'C++ 软件工程师（设备控制软件）',
    skills: ['C++', 'Qt', 'Modbus', 'TCP/IP', '多线程', 'PLC 通信', '设备控制', 'Python'],
    highlights: [
      '负责半导体封装设备上位机软件，覆盖配方管理、流程编排、报警与日志子系统',
      '实现与 PLC 的 Modbus / TCP 双通道通信，异常自恢复成功率 99.6%',
      '编写 Python 工具链用于软件版本发布与现场自检，交付效率提升约 30%',
    ],
    position: 'pos_cpp',
    score: 86,
    status: 'interview',
    hitPoints: [
      '10 年 C++ 设备软件经验',
      'Modbus / TCP / 多线程命中硬性条件',
      '半导体封装设备背景',
      'Qt + Python 命中加分项',
    ],
    missPoints: ['无 EtherCAT 经验', '运动控制涉及较浅（以流程控制为主）'],
    platform: 'boss',
    daysAgo: 8,
  },
  {
    name: '沈砚舟',
    gender: 'M',
    age: 31,
    city: '上海',
    degree: '硕士',
    school: '复旦大学',
    major: '光电信息工程',
    yoe: 5,
    company: 'Camtek（中国）',
    title: '光学工程师',
    salary: '50-68k',
    intention: '光学工程师（量测设备）',
    skills: ['Zemax', 'LightTools', '成像系统设计', '照明设计', '共聚焦', '光学检测', '装调'],
    highlights: [
      '负责晶圆检测设备光学模组设计，完成明场 / 暗场照明方案选型与验证',
      '参与共聚焦成像模块开发，横向分辨率达 0.5μm',
      '支持国内客户现场光学问题定位，累计处理 40+ 起成像异常',
    ],
    position: 'pos_optic',
    score: 86,
    status: 'screening',
    hitPoints: [
      '硕士 / 光电信息，专业对口',
      '5 年精密光学设计经验',
      'Zemax 熟练，命中硬性条件',
      '半导体检测设备 + 共聚焦经验，命中加分项',
    ],
    missPoints: ['干涉量测系统经验偏少', 'Code V 使用经验未体现'],
    platform: 'liepin',
    daysAgo: 10,
  },
  {
    name: '叶书宁',
    gender: 'F',
    age: 31,
    city: '北京',
    degree: '硕士',
    school: '中国科学院自动化研究所',
    major: '模式识别与智能系统',
    yoe: 6,
    company: '商汤科技',
    title: '高级算法工程师',
    salary: '65-85k',
    intention: '深度学习算法工程师（工业检测）',
    skills: ['PyTorch', '语义分割', '异常检测', '模型蒸馏', '目标检测', 'ONNX'],
    highlights: [
      '负责工业质检产品线的分割模型研发，缺陷 IoU 从 0.62 提升至 0.79',
      '设计蒸馏方案把大模型能力迁移到轻量模型，精度损失 < 1%',
      '支持 5 个行业客户完成算法定制交付',
    ],
    position: 'pos_dl',
    score: 87,
    status: 'new',
    hitPoints: [
      '中科院自动化所硕士，背景优秀',
      '6 年 CV 深度学习经验',
      '分割 + 异常检测双线经验',
      '模型蒸馏 / 轻量化能力，命中加分项',
    ],
    missPoints: ['在北京，需确认是否接受relocate 深圳', '薪资期望 65-85k 偏高', '无设备端部署经验'],
    platform: 'liepin',
    daysAgo: 0,
  },
  {
    name: '唐闵行',
    gender: 'M',
    age: 30,
    city: '深圳',
    degree: '本科',
    school: '武汉大学',
    major: '软件工程',
    yoe: 6,
    company: '矩子科技',
    title: 'C++ 工程师',
    salary: '40-52k',
    intention: 'C++ 软件工程师（设备控制软件）',
    skills: ['C++', 'Qt', '多线程', 'TCP/IP', '图像处理', 'CMake', 'OpenCV'],
    highlights: [
      '负责 AOI 设备上位机软件模块开发，包括图像采集与检测流程调度',
      '优化图像采集链路，将单帧传输延迟从 45ms 降至 12ms',
      '参与设备软件现场升级与问题排查',
    ],
    position: 'pos_cpp',
    score: 83,
    status: 'contacted',
    hitPoints: ['6 年 C++ 经验，达到 5 年要求', 'Qt + 多线程 + TCP/IP 命中', 'AOI 设备行业背景'],
    missPoints: ['无运动控制 / EtherCAT 经验', '学历本科', '偏模块开发，缺少架构设计经历'],
    platform: 'boss',
    daysAgo: 12,
  },
  {
    name: '卢沐晨',
    gender: 'F',
    age: 28,
    city: '上海',
    degree: '硕士',
    school: '上海大学',
    major: '计算机技术',
    yoe: 4,
    company: '中科飞测',
    title: '算法工程师',
    salary: '45-58k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'C++', 'OpenCV', '缺陷检测', 'PyTorch', '图像处理'],
    highlights: [
      '参与晶圆缺陷检测算法模块开发，负责预处理与特征提取部分',
      '完成缺陷样本标注规范制定与标注质量抽检',
      '支持算法在现场的阈值调优与误报分析',
    ],
    position: 'pos_vision',
    score: 83,
    status: 'contacted',
    hitPoints: ['硕士 / 计算机', '半导体量测设备行业背景（中科飞测）', 'OpenCV + C++ 能力'],
    missPoints: ['4 年经验略低于 5 年要求', '偏执行角色，缺少主导算法方案的经历', 'Halcon 未提及'],
    platform: 'boss',
    daysAgo: 0,
  },
  {
    name: '崔樱宁',
    gender: 'F',
    age: 30,
    city: '上海',
    degree: '硕士',
    school: '同济大学',
    major: '控制科学与工程',
    yoe: 5,
    company: '中微半导体',
    title: '软件工程师',
    salary: '45-58k',
    intention: 'C++ 软件工程师（设备控制软件）',
    skills: ['C++', 'Qt', 'EtherCAT', '多线程', '运动控制', 'SEMI 标准', 'Python'],
    highlights: [
      '负责刻蚀设备控制软件子系统开发，涉及腔体时序与安全联锁逻辑',
      '参与 EtherCAT 从站集成与调试，控制抖动 < 20μs',
      '按 SEMI 标准完成软件接口文档与版本管理',
    ],
    position: 'pos_cpp',
    score: 82,
    status: 'screening',
    hitPoints: ['硕士 / 控制科学', 'EtherCAT + 运动控制 + 多线程命中', '半导体设备（刻蚀）背景', '熟悉 SEMI 标准，命中加分项'],
    missPoints: ['5 年经验处于要求下限', '未体现图像采集链路经验', '期望城市为上海，需确认是否来深圳'],
    platform: 'boss',
    daysAgo: 11,
  },
  {
    name: '何雨桐',
    gender: 'F',
    age: 28,
    city: '深圳',
    degree: '硕士',
    school: '哈尔滨工业大学',
    major: '控制科学与工程',
    yoe: 5,
    company: '凌云光',
    title: '算法工程师',
    salary: '45-60k',
    intention: '深度学习算法工程师（工业检测）',
    skills: ['PyTorch', '缺陷检测', 'CNN', '数据增强', 'TensorRT', 'Python'],
    highlights: [
      '负责消费电子外观缺陷检测模型训练与迭代，模型准确率 95%',
      '引入数据增强与难例挖掘策略，小白点类缺陷召回提升 12 个百分点',
      '完成模型 TensorRT 转换与部署，推理速度提升 4 倍',
    ],
    position: 'pos_dl',
    score: 84,
    status: 'contacted',
    hitPoints: ['硕士，5 年 CV 经验', 'PyTorch 独立完成训练到部署', 'TensorRT 命中加分项', '缺陷检测落地经验'],
    missPoints: ['主要使用 CNN，缺少分割 / 异常检测方向经验', '无半导体或面板行业背景'],
    platform: 'offline',
    daysAgo: 14,
  },
  {
    name: '方清野',
    gender: 'M',
    age: 27,
    city: '深圳',
    degree: '硕士',
    school: '北京理工大学',
    major: '光学工程',
    yoe: 4,
    company: '华星光电',
    title: '光学工程师',
    salary: '40-55k',
    intention: '光学工程师（量测设备）',
    skills: ['Zemax', '光学仿真', '照明设计', '成像系统', '光学测量'],
    highlights: [
      '负责面板产线检测设备照明方案设计与验证，解决亮度不均问题',
      '参与成像系统公差分析，给出装配公差要求',
      '支持设备光学模块的现场调试与优化',
    ],
    position: 'pos_optic',
    score: 81,
    status: 'new',
    hitPoints: ['硕士 / 光学工程对口', 'Zemax 光学设计与仿真能力', '检测设备照明与成像经验'],
    missPoints: ['4 年经验略低于要求', '缺显微成像 / 干涉量测系统经验', 'Code V 未使用'],
    platform: 'boss',
    daysAgo: 0,
  },
  {
    name: '许亦涵',
    gender: 'F',
    age: 26,
    city: '深圳',
    degree: '硕士',
    school: '天津大学',
    major: '光学工程',
    yoe: 3,
    company: '京东方',
    title: '算法工程师',
    salary: '38-50k',
    intention: '高级视觉算法工程师（缺陷检测）',
    skills: ['Python', 'OpenCV', '缺陷检测', '图像处理', '深度学习'],
    highlights: [
      '参与面板缺陷检测算法开发，负责缺陷特征提取与规则优化',
      '完成缺陷误报case 归因分析，输出优化方案 8 项',
      '支持新线体算法参数迁移与验证',
    ],
    position: 'pos_vision',
    score: 79,
    status: 'new',
    hitPoints: ['硕士 / 光学工程，专业相关', '面板检测行业经验', 'OpenCV 与深度学习基础'],
    missPoints: ['3 年经验低于 5 年硬性要求', '未见 C++ / Halcon 能力', '缺少主导项目的经历'],
    platform: 'boss',
    daysAgo: 1,
  },
  {
    name: '邓允之',
    gender: 'M',
    age: 34,
    city: '上海',
    degree: '硕士',
    school: '东南大学',
    major: '仪器科学与技术',
    yoe: 8,
    company: 'Onto Innovation',
    title: '应用工程师',
    salary: '45-60k',
    intention: '应用工程师 / FAE（客户现场）',
    skills: ['设备调试', '缺陷分析', 'Python', '良率分析', '客户支持', '英文沟通'],
    highlights: [
      '负责量测设备在国内晶圆厂的导入与验收，累计完成 25 台设备装机',
      '主导 3 个客户的关键工艺缺陷攻关，帮助客户良率提升 1.5 个百分点',
      '作为技术窗口对接海外总部，英文可作为工作语言',
    ],
    position: 'pos_fae',
    score: 80,
    status: 'contacted',
    hitPoints: ['8 年半导体设备现场经验', '具备缺陷分析与良率分析能力', '英文可作为工作语言，命中加分项', 'Python 脚本能力'],
    missPoints: ['岗位当前为暂停状态', '主要在上海，出差范围需确认', '薪资期望高于该岗位预算'],
    platform: 'liepin',
    daysAgo: 16,
  },
  {
    name: '高致远',
    gender: 'M',
    age: 31,
    city: '深圳',
    degree: '本科',
    school: '华中科技大学',
    major: '机械电子工程',
    yoe: 7,
    company: '奥特维科技',
    title: '应用工程师',
    salary: '35-45k',
    intention: '应用工程师 / FAE（客户现场）',
    skills: ['设备调试', 'PLC', '客户支持', '故障排查', 'Python'],
    highlights: [
      '负责光伏与半导体封装设备现场导入，累计支持 40+ 台设备调试',
      '建立常见故障知识库，把现场问题平均处理时长压缩 35%',
      '配合算法团队收集缺陷样本并复现问题',
    ],
    position: 'pos_fae',
    score: 78,
    status: 'contacted',
    hitPoints: ['7 年设备现场经验', '有缺陷样本收集与问题复现配合经验', '沟通与客户支持能力强'],
    missPoints: ['光伏行业为主，半导体经验偏少', '未见英文能力描述', '岗位暂停中'],
    platform: 'boss',
    daysAgo: 18,
  },
  {
    name: '罗一鸣',
    gender: 'M',
    age: 26,
    city: '深圳',
    degree: '本科',
    school: '南京理工大学',
    major: '自动化',
    yoe: 4,
    company: '易鸿智能',
    title: '应用工程师',
    salary: '30-40k',
    intention: '应用工程师 / FAE（客户现场）',
    skills: ['设备调试', 'PLC', '现场支持', 'Shell'],
    highlights: [
      '负责锂电检测设备现场安装调试与客户培训',
      '配合研发完成现场问题复现与日志采集',
      '编写现场作业指导书 5 份',
    ],
    position: 'pos_fae',
    score: 74,
    status: 'new',
    hitPoints: ['4 年设备现场经验', '具备基础脚本能力'],
    missPoints: ['行业为锂电，与半导体 / 面板差异较大', '经验年限偏短', '未见英文能力'],
    platform: 'offline',
    daysAgo: 20,
  },
  {
    name: '汤景煜',
    gender: 'M',
    age: 29,
    city: '深圳',
    degree: '本科',
    school: '重庆大学',
    major: '自动化',
    yoe: 5,
    company: '精测电子',
    title: '售前应用工程师',
    salary: '32-42k',
    intention: '应用工程师 / FAE（客户现场）',
    skills: ['方案讲解', '设备演示', '客户沟通', 'Python'],
    highlights: [
      '负责检测设备售前技术支持与方案讲解',
      '参与客户需求调研并输出需求文档',
      '支持样机演示与竞品对比分析',
    ],
    position: 'pos_fae',
    score: 72,
    status: 'rejected',
    hitPoints: ['面板检测设备行业背景', '沟通表达能力强'],
    missPoints: ['偏售前，缺少现场装调与工艺调优经验', '无缺陷分析 / 良率分析经验', '岗位暂停中，暂不推进'],
    platform: 'boss',
    daysAgo: 22,
  },
  {
    name: '邵怀安',
    gender: 'M',
    age: 32,
    city: '苏州',
    degree: '硕士',
    school: '长春理工大学',
    major: '光学工程',
    yoe: 6,
    company: '迈为股份',
    title: '光学工程师',
    salary: '42-55k',
    intention: '光学工程师（量测设备）',
    skills: ['Zemax', '光学设计', '激光光学', '成像系统'],
    highlights: [
      '负责激光加工设备光学系统设计与选型',
      '完成激光聚焦光路设计与仿真，光斑均匀性达设计要求',
      '参与光机结构协同设计',
    ],
    position: 'pos_optic',
    score: 77,
    status: 'new',
    hitPoints: ['硕士 / 光学工程对口', '6 年光学设计经验', 'Zemax 仿真能力'],
    missPoints: ['方向为激光加工，与量测 / 显微成像不符', '无干涉量测经验', '在苏州，需确认是否接受 relocate 上海'],
    platform: 'offline',
    daysAgo: 25,
  },
]

// ------------------------------------------------------------
// 组装
// ------------------------------------------------------------

/** 生成 N 天前的 ISO 时间（带一点随机时刻，避免全是同一分钟） */
function daysAgoIso(days: number, salt = 0): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(9 + (salt * 3) % 9, (salt * 17) % 60, (salt * 29) % 60, 0)
  // 把「今天」的时间钉在 09:00–17:00 之间，凌晨跑（比如 00:07）时这个点还没到，
  // 示例数据就会落到**未来** —— 后果很直观：看板按「最新采集」排序时，
  // 示例简历反而排在你刚刚采集进来的真实简历前面。
  // 所以落在未来就整体往前挪一天，保证示例数据永远是「已经发生过的」。
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d.toISOString()
}

function resumeTextOf(s: Spec): string {
  const lines = [
    `${s.name}`,
    `性别：${s.gender === 'M' ? '男' : '女'}    年龄：${s.age} 岁    所在城市：${s.city}`,
    `学历：${s.degree}    毕业院校：${s.school}    专业：${s.major}`,
    `工作年限：${s.yoe} 年`,
    `当前公司：${s.company}    当前职位：${s.title}`,
    `期望薪资：${s.salary}`,
    `求职意向：${s.intention}`,
    '',
    `【技能标签】${s.skills.join('、')}`,
    '',
    '【工作经历】',
    ...s.highlights.map((h, i) => `${i + 1}. ${h}`),
    '',
    '【自我介绍】',
    `在工业视觉 / 精密检测方向有 ${s.yoe} 年工程经验，熟悉从方案评估到设备端量产落地的完整链路，习惯以数据驱动的方式定位与解决问题。`,
  ]
  return lines.join('\n')
}

export function buildSeedDatabase(): SeedDatabase {
  const positions: Position[] = POSITIONS.map((p, i) => ({
    ...p,
    createdAt: daysAgoIso(60 - i * 5, i),
  }))

  const candidates: Candidate[] = []
  const matches: Match[] = []
  const sources: CandidateSource[] = []

  SPECS.forEach((s, i) => {
    const created = daysAgoIso(s.daysAgo, i)
    const candidateId = `cand_seed_${String(i + 1).padStart(3, '0')}`

    candidates.push({
      id: candidateId,
      name: s.name,
      gender: s.gender,
      age: s.age,
      city: s.city,
      degree: s.degree,
      school: s.school,
      major: s.major,
      yearsOfExperience: s.yoe,
      currentCompany: s.company,
      currentTitle: s.title,
      expectedSalary: s.salary,
      intention: s.intention,
      phone: `1${String(30 + (i % 9))}****${String(1000 + i * 137).slice(-4)}`,
      email: `candidate${i + 1}@example.com`,
      skills: s.skills,
      summary: `${s.yoe} 年工业视觉 / 精密检测经验，现于${s.company}任${s.title}。${s.highlights[0]}`,
      resumeText: resumeTextOf(s),
      parseState: 'parsed',
      createdAt: created,
      updatedAt: created,
    })

    matches.push({
      id: `match_seed_${String(i + 1).padStart(3, '0')}`,
      candidateId,
      positionId: s.position,
      score: s.score,
      hitPoints: s.hitPoints,
      missPoints: s.missPoints,
      status: s.status,
      owner: '霖酱',
      note: '',
      modelVersion: 'seed-demo-v1',
      createdAt: created,
      updatedAt: created,
    })

    sources.push({
      id: `src_seed_${String(i + 1).padStart(3, '0')}`,
      candidateId,
      platform: s.platform,
      // 平台内 ID 造得像真实的：BOSS 用短串，猎聘用长串，离线用文件名
      platformCandidateId:
        s.platform === 'boss'
          ? `${s.name}-boss-${1080 + i}`
          : s.platform === 'liepin'
            ? `lp_${String(700000 + i * 313).slice(0, 6)}${i}`
            : `offline/${s.name}-${s.title}.pdf`,
      resumeUrl:
        s.platform === 'boss'
          ? `https://www.zhipin.com/web/geek/resume?geekId=${1080 + i}`
          : s.platform === 'liepin'
            ? `https://c.liepin.com/resume/showresumedetail/?res_id=${700000 + i * 313}`
            : '',
      capturedAt: created,
    })

    // 让「一人多岗」的场景也有数据：2 位候选人同时进入 2 个岗位
    if (i === 0 || i === 5) {
      const second = i === 0 ? 'pos_dl' : 'pos_vision'
      const secondPos = positions.find((p) => p.id === second)!
      matches.push({
        id: `match_seed_x${String(i + 1).padStart(3, '0')}`,
        candidateId,
        positionId: second,
        score: Math.max(60, s.score - 7),
        hitPoints: [`可作为${secondPos.title}的备选：${s.hitPoints[0]}`],
        missPoints: ['与备选岗位的核心要求存在一定偏差，需沟通确认意愿'],
        status: 'new',
        owner: '霖酱',
        note: '备选岗位',
        modelVersion: 'seed-demo-v1',
        createdAt: created,
        updatedAt: created,
      })
    }
  })

  return { version: 1, candidates, positions, matches, sources }
}
