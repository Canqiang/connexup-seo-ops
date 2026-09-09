为「SEO Ops」内部运营控制台设计 GBP Post 任务的界面原型，文件名 index.html，桌面 1180px 起，只使用设计系统 seo-ops 的 tokens.css 变量，不引入任何外部字体、图标或脚本库。整页是一份静态原型集：顶部一段说明，然后按下面顺序排 9 个区块，每个区块用 `<section id="…">` 包裹并带 h2 标题，所有状态并排静态展示，不依赖点击。

背景：一个 GBP_POST 任务 = 为一家餐厅的一个 Google Business Profile 门店准备并发布一篇帖子。内容和图片由「内容 Agent」生成，操作员只能批准或退回，批准后由「发布 Agent」写入 Google，系统读回 Google 上的帖子精确匹配后才算完成。任务状态依次是 PENDING（待开始）、PREPARING（内容准备中）、AWAITING_APPROVAL（待审批）、EXECUTING（发布中）、VERIFYING（核对中）、DONE（已上线）、NEEDS_ATTENTION（需要处理）。

通用页面骨架（每个任务页区块都沿用）：左侧固定导航栏不用画；页面顶部是「任务上下文」条：返回链接「← 示例商户」、任务标题「为 2020 Broadway 门店发布一篇 brunch 主题帖子」、状态戳记、来源「Plan #12 · revision 3」；下面是「生命周期轨迹」：七个状态的水平步骤条，当前状态高亮，已过状态打勾；主区左 2/3 是「帖子卡」，右 1/3 是 rail。

帖子卡（模拟 GBP Post 最终样子，宽约 420px，白卡、1px 边）：顶部图片区 4:3（用 tokens 里的浅色块代替真实图片，左上角角标戳记「AI 生成」或「商户照片」）；正文示例：「Looking for Hakka and Chinese around Broadway? George Merchant at 2020 Broadway is your friendly local spot for a relaxed brunch. Stop by and see us soon.」；CTA 按钮「Learn more」；底部小字「George Merchant · 2020 Broadway, New York, NY」。

rail 的「发布身份」卡：`dl` 参数表，字段：目标门店（accounts/…/locations/6709824005172040369）、批准人与时间（xander · 2026-09-09 14:20）、Artifact checksum（b4de70ec4954…）、图片来源与 sha256（商户照片 · f78ee971ac70…）、发布 Agent（SEO Ops GBP Post Publisher - 2026-09-09）、audit_id（aud_8f2c…）。

9 个区块：

1）`task-preparing`：任务页，状态 PREPARING。帖子卡是骨架屏（图片块和三行文字用 breathe 呼吸动画，prefers-reduced-motion 下静止），卡顶写「内容 Agent 准备中 · 加载中…」并带 role="status"。卡下方是「本次准备使用的输入」清单：门店 2020 Broadway、主题 brunch、关键词簇「hakka / chinese / brunch」、风格档案 v1、日历上下文「Labor Day 2026-09-07 · 本期优惠：Weekday Brunch Set」、候选图 6 张。rail 显示「发布身份」卡的空态（尚未批准）。

2）`task-preparing-blocked`：同上，但商户没有风格档案：帖子卡位置换成一条 warning 提示「该商户尚未填写风格档案，内容 Agent 无法开始。」并带按钮「去填写风格档案」；「开始内容准备」按钮禁用。

3）`task-awaiting-approval`：状态 AWAITING_APPROVAL。完整帖子卡（图片角标「商户照片」）。卡下方「依据」折叠区（默认展开）：关键词 hakka / chinese / brunch；证据引用 3 条（fbr-keyword-set:54b7…、gbp-location-readback:6709…、merchant-style-profile:v1）；Agent limitations 2 条原文：「No absolute HTTPS URL was supplied for a booking page, so cta_type is LEARN_MORE with the website URL.」「Copy contains no phone number per policy.」。操作区两个按钮：主按钮「批准并发布」（危险色，因为会写入 Google），次按钮「退回重新准备」。旁边一行小字：「批准后由发布 Agent 写入 Google，不能撤回；发布后如需修改，请新建补偿任务。」

4）`task-approve-dialog`：在区块 3 的基础上叠一个确认对话框（沿用 seo-ops 的确认对话框骨架：眉标「GBP POST / PUBLISH」、标题「批准并发布这篇帖子」、正文「发布 Agent 会把这一版内容和图片写入 Google 门店 2020 Broadway。发布后不能撤回，只能新建补偿任务修改。确认发布？」、参数表：目标门店、Artifact checksum、图片来源；footer「取消」+ 危险确认按钮「确认发布」）。遮罩不关闭。

5）`task-executing`：状态 EXECUTING。帖子卡只读并在右上角加锁戳记「已锁定」。卡上方一条 status 提示「发布 Agent 执行中，页面每 10 秒刷新」，显示 Attempt #1、触发时间、audit_id。没有任何操作按钮。rail「发布身份」卡填满。

6）`task-verifying`：状态 VERIFYING。提示换成「已提交 Google，等待读回 · 下次自动核对 4:32 后」，带按钮「立即重新核对」。

7）`task-done`：状态 DONE。帖子卡顶部戳记「已上线」（success 色），卡下方参数表：Google post_id（localPosts/8123…）、读回时间、search_url 链接「在 Google 上查看」。没有操作按钮。

8）`task-needs-attention`：状态 NEEDS_ATTENTION。页面顶部一条 409 风格的横幅（橙底）：戳记「需要处理」+ 文案「Google 上读到 2 条内容完全一致的帖子，无法确定哪一条是本次发布。」+ 唯一按钮「重新核对」。主区分两栏：左边批准的帖子卡；右边「Google 上读到的最近帖子」列表 4 条，每条：缩略图、摘要前 80 字、状态戳记（LIVE / PROCESSING / REJECTED）、时间；其中两条精确匹配的用高亮边框和「精确匹配」戳记。列表下方小字：「补救请新建补偿任务，本任务不可修改。」

9）`merchant-and-profile`：三张并排的卡，展示商户侧的新界面：
   a. 商户页「新建任务」表单：任务类型下拉（PREPARE_ONLY / GBP_POST，选中 GBP_POST）、门店下拉（只列已绑定的 GBP 门店：2020 Broadway）、主题输入「brunch」、提示行「内容和图片由 Agent 生成，你只审批」、按钮「创建任务」。
   b. 商户页「本期活动与优惠」列表：表头 标题 / 类型 / 起止 / 来源，两行示例（Weekday Brunch Set · 优惠 · 09-01 到 09-30 · 商户提供；Labor Day Hours · 活动 · 09-07 · 商户提供），下方「＋ 新增」按钮。
   c. 商户资料页「风格档案」卡：版本 v1、语气标签（clear / friendly / local）、帖子结构 4 条、禁忌 3 条、图片策略优先级（商户照片 › 操作员上传 › AI 生成）、备注；按钮「编辑并保存为 v2」。旁边「图库」卡：3×2 网格，6 张浅色占位图，每张左上角来源戳记（FBR 菜品图 / FBR 帖子图 / 操作员上传），已授权的右上角打勾，下方按钮「上传真实照片」。

整体延续现有语言：瓷灰底、白卡片、墨蓝文字、橙色主按钮、戳记式状态，不要引入渐变、毛玻璃或大圆角。所有中文文案按上面原句使用。
