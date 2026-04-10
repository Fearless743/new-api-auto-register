package server

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"new-api-auto-register/internal/storage"
)

func renderManagementLoginPage(errorMessage string) string {
	errorBlock := ""
	if errorMessage != "" {
		safeMsg := strings.ReplaceAll(errorMessage, "&", "&amp;")
		safeMsg = strings.ReplaceAll(safeMsg, "<", "&lt;")
		safeMsg = strings.ReplaceAll(safeMsg, ">", "&gt;")
		errorBlock = fmt.Sprintf(`<div class="error">%s</div>`, safeMsg)
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>管理页验证</title>
  <style>
    :root {
      --bg: #f6efe5;
      --panel: rgba(255,255,255,0.88);
      --ink: #201814;
      --muted: #70645a;
      --line: rgba(32,24,20,0.12);
      --accent: #201814;
      --bad: #bf4d3a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(184,144,78,0.18), transparent 30%%),
        linear-gradient(180deg, #faf5ef 0%%, #ede1d3 100%%);
      color: var(--ink);
      font-family: "Noto Serif SC", "Source Han Serif SC", serif;
    }
    .panel {
      width: min(480px, calc(100vw - 32px));
      padding: 28px;
      border-radius: 28px;
      background: var(--panel);
      border: 1px solid rgba(255,255,255,0.6);
      box-shadow: 0 30px 80px rgba(57, 42, 31, 0.16);
    }
    .eyebrow {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.22em;
      color: var(--muted);
      margin-bottom: 16px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 42px;
      line-height: 0.98;
    }
    p {
      margin: 0 0 18px;
      color: var(--muted);
      line-height: 1.7;
    }
    form {
      display: grid;
      gap: 12px;
    }
    input, button {
      width: 100%%;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 14px 16px;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: #f7efe5;
      cursor: pointer;
    }
    .error {
      margin-bottom: 14px;
      color: var(--bad);
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="eyebrow">Admin Gate</div>
    <h1>输入管理员密钥</h1>
    <p>只有通过管理员密钥验证后，才可以进入账户管理页面并查看敏感账号状态。</p>
    %s
    <form method="post" action="/management/login">
      <input type="password" name="adminKey" placeholder="管理员密钥" required>
      <button type="submit">进入管理页</button>
    </form>
  </div>
</body>
</html>`, errorBlock)
}

func decodeJSON(r io.Reader, dest interface{}) error {
	return json.NewDecoder(r).Decode(dest)
}

func filterAccounts(accounts []storage.Account, keyword, statusMode, step string) []storage.Account {
	workflowSteps := []string{"register", "login", "tokenCreate", "tokenList"}

	var result []storage.Account
	for _, account := range accounts {
		// Keyword filter
		if keyword != "" {
			haystack := []string{account.Username, account.Token, account.NewAPIUser, account.Session}
			haystackStr := strings.Join(haystack, " ")
			haystackStr = strings.ToLower(haystackStr)
			keyword = strings.ToLower(keyword)
			if !strings.Contains(haystackStr, keyword) {
				continue
			}
		}

		workflow := account.Workflow

		steps := workflowSteps
		if step != "" && step != "all" {
			steps = []string{step}
		}

		var hasFailed, hasIdle, allSuccess bool
		for _, s := range steps {
			var st string
			switch s {
			case "register":
				st = workflow.Register.Status
			case "login":
				st = workflow.Login.Status
			case "tokenCreate":
				st = workflow.TokenCreate.Status
			case "tokenList":
				st = workflow.TokenList.Status
			}
			if st == "failed" {
				hasFailed = true
			}
			if st == "" || st == "idle" {
				hasIdle = true
			}
			if st == "success" {
				allSuccess = true
			} else {
				allSuccess = false
			}
		}

		// Re-evaluate allSuccess - it's true only if ALL steps are success
		allSuccess = true
		for _, s := range steps {
			var st string
			switch s {
			case "register":
				st = workflow.Register.Status
			case "login":
				st = workflow.Login.Status
			case "tokenCreate":
				st = workflow.TokenCreate.Status
			case "tokenList":
				st = workflow.TokenList.Status
			}
			if st != "success" {
				allSuccess = false
				break
			}
		}

		switch statusMode {
		case "failed-only":
			if !hasFailed {
				continue
			}
		case "success-only":
			if !allSuccess {
				continue
			}
		case "idle-only":
			if !hasIdle {
				continue
			}
		}

		result = append(result, account)
	}
	return result
}

func buildAccountsSummary(accounts, filteredAccounts []storage.Account) map[string]interface{} {
	workflowSteps := []string{"register", "login", "tokenCreate", "tokenList"}

	var failed, success int
	for _, account := range accounts {
		hasFailed := false
		allSuccess := true

		for _, step := range workflowSteps {
			var st string
			switch step {
			case "register":
				st = account.Workflow.Register.Status
			case "login":
				st = account.Workflow.Login.Status
			case "tokenCreate":
				st = account.Workflow.TokenCreate.Status
			case "tokenList":
				st = account.Workflow.TokenList.Status
			}
			if st == "failed" {
				hasFailed = true
			}
			if st != "success" {
				allSuccess = false
			}
		}

		if hasFailed {
			failed++
		}
		if allSuccess {
			success++
		}
	}

	// Find latest updated timestamp
	var latest *string
	for _, account := range accounts {
		var ts []string
		if account.Workflow.Register.LastRunAt != nil {
			ts = append(ts, string(*account.Workflow.Register.LastRunAt))
		}
		if account.Workflow.Login.LastRunAt != nil {
			ts = append(ts, string(*account.Workflow.Login.LastRunAt))
		}
		if account.Workflow.TokenCreate.LastRunAt != nil {
			ts = append(ts, string(*account.Workflow.TokenCreate.LastRunAt))
		}
		if account.Workflow.TokenList.LastRunAt != nil {
			ts = append(ts, string(*account.Workflow.TokenList.LastRunAt))
		}
		if account.UpdatedAt != nil {
			ts = append(ts, string(*account.UpdatedAt))
		}
		for _, t := range ts {
			if latest == nil || t > *latest {
				latest = &t
			}
		}
	}

	return map[string]interface{}{
		"all": map[string]interface{}{
			"total":   len(accounts),
			"failed":  failed,
			"success": success,
			"updated": latest,
		},
		"filtered": map[string]interface{}{
			"total": len(filteredAccounts),
		},
	}
}
