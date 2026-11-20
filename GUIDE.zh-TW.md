# ORCH（rexwic fork）使用指南

這是一個讓多個 AI agent 像同事一樣分工的系統：PM 寫需求、planner 拆 task、工程師開發、reviewer 審 code、QA 驗收開 bug。你只在「它們決定不了」的時候介入。

所有指令都是 `orch <群組> <動作>`，例如 `orch prd new "..."`。任何指令加 `--help` 可看完整參數。

---

## 1. 快速開始（Java 專案）

```bash
cd my-java-project            # 必須是 git repo
orch init --name my-project   # 建立 .orchestry/
orch role init software       # 建立內建的軟體團隊角色（見第 3 節）
```

把驗收用的測試指令改成 Maven（編輯 `.orchestry/config.yml`，或 `orch config edit`）：

```yaml
review:
  commands:
    test_pass: { default: "./mvnw -q test", win32: "mvnw.cmd -q test" }
```

開始一個需求：

```bash
orch prd new "訂單可以套用折扣碼，每張訂單最多一個" --name order-discount
orch dashboard --run          # 開網頁並同時執行 orchestrator
```

接下來在網頁上：看 PM 寫好的 PRD → 看 planner 拆好的計畫 → 核准 → 團隊開始做 → 有問題才出現在你的決策清單。

> 不需要 PRD 時可以直接 `orch plan new "需求"`；只想派一個 task 時用 `orch task add "標題" --role backend`。

---

## 2. 整體流程

```
你的需求
  └─ orch prd new ──► PM 寫 PRD v1 ──► planner 自動拆計畫
                                         └─ 你核准計畫（同時核准 PRD）
                                              └─ 建立 goal + tasks
task 執行：
  工程師開發（各自的 git worktree / branch）
    └─ 交付報告 orch task deliver
        └─ 自動檢查：測試指令、契約檔沒被改、produces 檔案存在
            └─ reviewer 審查（最多 2 輪）
                └─ 合併前先把最新 main merge 進來再驗一次
                    └─ 合併進 main（auto），或等你 approve（manual）
  QA task（依賴開發 task）
    └─ 驗收、開 bug 給單一負責角色 ──► 修好後自動複測
```

agent 有疑問時：先問 PM，PM 決定不了才轉給你。

---

## 3. 角色（roles）

角色定義在 `.orchestry/roles/<name>.yml`，這是唯一的設定來源；改完後 `serve` / `run` / `dashboard --run` 每個 tick 自動套用，或手動 `orch role sync`。

### 內建 `software` 樣板

| 角色 | adapter / 模型 | 數量 | 職責（duties） |
|---|---|---|---|
| pm | claude opus | 1 | `write_prd`、`answer_questions` |
| planner | claude opus | 1 | `plan` |
| backend | claude sonnet, effort high | 2 | 開發；預設驗收 `test_pass` |
| frontend | claude sonnet, effort high | 1 | 開發 |
| qa | claude sonnet | 1 | `verify`，bug 可指派給 backend / frontend |
| reviewer | codex | 1 | `review`，審 backend / frontend |

### 角色 yml 欄位

```yaml
name: backend
adapter: claude              # claude, codex, antigravity, opencode, cursor, pi, grok, shell
model: sonnet
effort: high                 # low | medium | high
replicas: 2                  # 這個角色有幾個 agent 同時工作
description: Backend engineer (Java / Spring)
system_prompt: |             # 角色指示，會以「## Your role」附加在 agent 的 system prompt
  You are a backend engineer ...
approval_policy: auto        # auto：審過就自動合併；manual：等你 orch task approve
workspace_mode: worktree     # worktree（建議）| shared | isolated
skills: [review]             # 注入 prompt 的 skill
quota_group: my-team-account # 選填：手動指定共用額度的帳號群組
task_defaults:
  review_criteria: [test_pass]   # test_pass | typecheck | lint
deliverable:
  required: true                 # 是否必須交付報告
  sections: [Summary, Verification, Open issues]
duties: [review]             # plan | write_prd | answer_questions | review | verify
reviews: [backend, frontend] # 有 review 職責時：審哪些角色的 task
bug_owners: [backend, frontend]  # 有 verify 職責時：bug 可以指派給誰
```

ORCH 依 `duties` 分派工作，不看角色名稱，所以可以自訂任何團隊（例如把 PM 改叫 `product`、用 Gemini 當 reviewer）。

### 指令

| 指令 | 用途 |
|---|---|
| `orch role init software` | 套用內建樣板（`--force` 覆蓋已存在的角色） |
| `orch role init ./my-team` | 從一個放 `.yml` 的資料夾套用 |
| `orch role init <name>` | 從 `~/.orchestry/templates/<name>/` 套用（自己的樣板放這） |
| `orch role templates` | 列出可用樣板 |
| `orch role add <name> --adapter claude --model sonnet ...` | 新增單一角色 |
| `orch role list` / `show <name>` | 查看角色和它的 agent |
| `orch role scale <name> <n>` | 調整 agent 數量（先移除閒置的） |
| `orch role remove <name>` | 刪除角色 |

---

## 4. PRD（產品需求）

PRD 存在 `.orchestry/prds/<name>/v1.md, v2.md ...`，有版本。

| 指令 | 用途 |
|---|---|
| `orch prd new "需求" --name order-discount` | PM 起草 PRD，完成後自動啟動 planner。`-f file.md` 從檔案讀需求 |
| `orch prd list` | 列出 PRD 與最新版本 |
| `orch prd show <name> [版本]` | 看 PRD |
| `orch prd diff <name> [from] [to]` | 兩版差異，並列出建立在舊版上的已完成 task |
| `orch prd add <name> -f file.md` | 存新版本（PM agent 也用這個） |

規則：
- PRD v1 跟計畫一起核准，不需要另外核准。
- 之後 PM 回答問題時改了 PRD → 產生新版本，不需要你核准，但會在 `orch decision list` / dashboard 顯示「PRD 有更新」。
- 已完成的 task 不會自動重做。要針對新版本補做：`orch plan new --prd <name> --since <舊版號>`，只規劃差異的部分。

---

## 5. 計畫（plan）

| 指令 | 用途 |
|---|---|
| `orch plan new "需求"` | planner 拆 task。`--prd <name>` 依 PRD 規劃；`-f` 讀檔 |
| `orch plan list [--all]` | 列出計畫 |
| `orch plan show <id>` | 看 task、角色、依賴順序、scope、契約 |
| `orch plan approve <id>` | 核准 → 建立 goal 和所有 task |
| `orch plan reject <id> -m "意見"` | 退回，planner 依意見產生下一版 |
| `orch plan cancel <id>` | 放棄計畫 |

設定：`planner.max_tasks`（預設 30）。planner 可以把高風險 task 標成 needs_decision，開始前要你同意。

---

## 6. Task

| 指令 | 用途 |
|---|---|
| `orch task add "標題" --role backend` | 新增 task，任何閒置的 backend agent 會接 |
| `orch task list` / `show <id>` | 查看（show 含交付報告和審查結果） |
| `orch task approve <id>` | 核准 review 中的 task：merge main → 重驗 → 合併 → done |
| `orch task reject <id> -r "原因"` | 退回重做 |
| `orch task cancel <id>` | 取消（會刪掉它的 worktree 和 branch） |
| `orch task retry <id>` | 重試失敗的 task |
| `orch task edit <id>` | 用編輯器改標題、優先度、描述 |

`task add` 常用參數：

| 參數 | 意思 |
|---|---|
| `-d "描述"` / `-e` | 描述 / 用編輯器寫 |
| `--depends-on id1,id2` | 依賴的 task 做完才開始 |
| `--scope "src/order/**"` | 只能改這些檔案 |
| `--review-criteria test_pass,lint` | 交付後自動跑的檢查 |
| `--produces docs/api/order.yaml` | 這個 task 必須產出的檔案（例如 API 契約） |
| `--uses docs/api/order.yaml` | 這個 task 必須遵守、不能修改的契約檔 |
| `--prd order-discount` | 實作哪份 PRD（最新版放進 prompt） |
| `--needs-decision "問題"` | 開始前要你同意 |
| `--attach a.png,spec.pdf` | 附件 |
| `-p 1..4` / `--max-attempts n` | 優先度 / 最多重試次數 |
| `--workspace-mode worktree` | 工作區模式 |

### 交付報告

每個開發 task 結束時，agent 必須執行 `orch task deliver report.md --status done|partial|blocked`：
- 報告要有角色規定的段落（預設 Summary / Verification / Open issues），`--produces` 的檔案要存在。
- 沒交報告 → 這次執行算失敗，重試。
- `partial` 或 `blocked` → 開決策單給你。

### API 契約（produces / uses）

- 前後端都參與時，planner 會讓第一個 task 寫 OpenAPI 檔（`produces`），前後端 task 都 `uses` 它。
- 契約內容自動放進 agent 的 prompt。
- 使用契約的 task 改了契約檔 → 自動退回（原因：contract）。
- 前後端互推 bug 時，以契約判定誰負責。

---

## 7. 審查（review）

有 `review` 職責的角色會自動審它 `reviews` 列出的角色的每個 task（內建樣板：Codex 審 backend 和 frontend）。

- 發現分三級：**must-fix**（bug、違反驗收條件/契約/PRD、安全、缺測試）、**should**、**nit**。只有 must-fix 會退回。
- 第 2 輪只驗證第 1 輪的 must-fix 是否修好；第 2 輪才提出的新問題只記為 should。
- 2 輪後還沒過 → 開決策單給你。
- 審查發生在測試檢查通過之後、合併之前；只適用 worktree 模式的 task。

| 指令 | 用途 |
|---|---|
| `orch review show <task>` | 看審查結果與每一輪的發現 |
| `orch review submit review.yml` | reviewer agent 提交審查結果 |

---

## 8. Bug

有 `verify` 職責的角色（QA）開 bug，每個 bug 只有一個負責角色。

- 負責角色可以轉派一次（`orch bug reassign`），第二次轉派 → 決策單，由你選誰負責。
- 同一個 QA task 開的 bug 全部修完 → 自動開複測 task。
- 複測仍沒修好 → 決策單：你可以接受現狀，或附指示讓 bug 以第 2 輪重開。
- 修 bug 的 task 一樣經過審查才合併。

| 指令 | 用途 |
|---|---|
| `orch bug list [--all]` | 列出 bug |
| `orch bug add "標題" --owner backend --repro ... --expected ... --actual ...` | 開 bug（你也可以手動開）。`--contract` 指定判定用的契約檔 |
| `orch bug reassign <bug> --to frontend -m "原因"` | 轉派 |
| `orch bug verify <bug> --fixed` / `--not-fixed -m "..."` | 複測結果 |

---

## 9. 決策（你需要介入的地方）

所有需要你的事情都集中在決策清單，CLI 或 dashboard 都能處理。

會產生決策的情況：agent 的問題（PM 回答不了）、計畫待核准、needs_decision 的 task、交付 partial/blocked、退回次數到上限（預設 3 次）、審查 2 輪未過、bug 第二次轉派、複測未過。

| 指令 | 用途 |
|---|---|
| `orch decision list [--all]` | 待你處理的決策（也顯示 PRD 更新） |
| `orch decision show <id>` | 看問題、選項、背景 |
| `orch decision answer <id> -c 1` | 選一個選項 |
| `orch decision answer <id> -m "指示"` | 回答／給指示 |
| `orch decision answer <id> --approve` | 核准（task 照現狀合併、gate 放行、計畫核准） |
| `orch decision answer <id> --cancel` | 取消 task |
| `orch decision answer <id> -m "規則" --project` | 變成全專案規則，之後每個 agent 都看得到 |

agent 端使用：`orch decision request "問題" -o 選項A -o 選項B`、PM 用 `orch decision escalate <id> -m "原因"` 轉給你。

---

## 10. Dashboard（網頁）

```bash
orch dashboard --run      # 開網頁 + 執行 orchestrator
orch dashboard            # 只開網頁（另一個視窗已經在跑 orch run --watch / serve）
```

參數：`-p 4777`（預設埠，被占用會換）、`--no-open`（不自動開瀏覽器）。只聽 127.0.0.1，網址帶 token。

網頁上可以：看 agent / task / 計畫 / PRD 狀態；回答決策（選選項、給指示、approve、取消）；核准、退回或放棄計畫；核准並合併或退回審查中的 task；取消 task；把 PRD 更新標為已讀。每 5 秒更新，你在打字時不會刷新。

「需要你處理」區會列出等你核准的 task（例如 `approval_policy: manual` 的角色、合併失敗停在審查中的 task）。點開任何審查中的 task 也有同樣的按鈕；reviewer 還在審時會提示「現在核准會略過審查」。退回必須寫原因，agent 會依原因重做。

---

## 11. 執行 orchestrator

| 指令 | 用途 |
|---|---|
| `orch dashboard --run` | 建議用法 |
| `orch run --watch [--verbose]` | 在終端機持續執行 |
| `orch run --all` | 跑完目前所有 todo |
| `orch serve [--once] [--log-format text] [--log-file x.log]` | 背景常駐，結構化 log |
| `orch tui` | 終端機版 dashboard |
| `orch status` | 目前狀態 |
| `orch logs` | 執行紀錄 |
| `orch doctor` | 檢查 adapter（claude、codex…）是否可用 |

### 額度用完（quota）

某個 agent 碰到用量上限時，同一個帳號（同一個 CLI 登入或同一把 API key）的所有 agent 一起暫停到重置時間，task 回到佇列，之後自動繼續。Gemini 透過 `antigravity`（agy）adapter。

### 合併方式

- 每個 task 在自己的 worktree / branch 開發。
- 合併前先把最新 main **merge**（不是 rebase）進 task branch，再跑一次檢查；有衝突或檢查失敗 → 自動退回給 agent，共用 `review.max_send_backs`（預設 3），超過就開決策單。
- 核准後透過合併佇列依序合併到 main。

---

## 12. 設定（`.orchestry/config.yml`）

`orch config get <key>` / `orch config set <key> <value>` / `orch config edit`。

| key | 預設 | 意思 |
|---|---|---|
| `review.commands.test_pass` / `typecheck` / `lint` | npm test / npx tsc --noEmit / npm run lint | 檢查指令，可分平台（見第 1 節） |
| `review.timeout_ms` | 600000 | 每個檢查的逾時 |
| `review.max_parallel` | 1 | 同時跑幾個檢查（mvn test 會搶 CPU、port、DB） |
| `review.max_send_backs` | 3 | 自動退回次數上限 |
| `planner.role` / `planner.max_tasks` | planner / 30 | planner 角色、計畫 task 上限 |
| `pm.role` | pm | PM 角色 |
| `deliverables.required` | true | 是否必須交付報告 |
| `scheduling.max_concurrent_agents` | 6 | 同時執行的 agent 上限 |
| `scheduling.poll_interval_ms` | 10000 | tick 間隔 |
| `defaults.agent.timeout_ms` | 3600000 | 單次執行逾時 |
| `defaults.agent.stall_timeout_ms` | 600000 | 多久沒輸出算卡住 |
| `defaults.task.max_attempts` | 3 | 失敗重試次數 |

---

## 13. 其他（上游原有功能）

| 指令 | 用途 |
|---|---|
| `orch agent ...` | 直接管理單一 agent（一般用 role 就好） |
| `orch goal ...` / `orch team ...` | 目標、團隊 |
| `orch context ...` / `orch msg ...` | agent 之間共享資料與訊息 |
| `orch org ...` | 上游預建的「AI 公司」 |
| `orch update` | 檢查更新 |

---

## 14. 目前的限制

- 只用 shell 假 agent 跑過端到端流程，還沒用真的 Claude / Codex 實際跑過。
- Codex / agy 額度用完的錯誤訊息格式是推測的，沒實際遇過；Claude 的已驗證。
- 審查與契約檢查只套用在 worktree 模式的 task。
- PRD 改版後，已完成的 task 不會自動重做（用 `plan new --since`）。
- dashboard 的確認對話框按鈕、Windows 自動開瀏覽器尚未實測。
