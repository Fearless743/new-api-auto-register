package tasks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"new-api-auto-register/internal/storage"
)

const (
	ProviderName      = "lxcloud"
	ProviderBaseURL   = "https://open.lxcloud.dev/v1"
	ProviderTestModel = "gpt-5.2-codex"
	ProviderPriority  = 10
)

var ProviderModels = []string{
	"gpt-5.2-codex",
	"gpt-5.4",
	"gpt-5.3-codex",
	"gpt-5.2",
	"gpt-5-codex-mini",
	"gpt-5.1-codex-mini",
	"gpt-5",
	"gpt-5.1",
	"gpt-5.1-codex-max",
	"gpt-5.1-codex",
	"gpt-5-codex",
}

func RunTokenUpload(storePath string) (map[string]any, error) {
	config := LoadConfig()
	config.StorePath = storePath

	if config.ManagementURL == "" {
		return nil, errors.New("MANAGEMENT_OPENAI_COMPAT_URL is required")
	}
	if config.ManagementBearer == "" {
		return nil, errors.New("MANAGEMENT_BEARER is required")
	}

	txtTokens := readTokensFromTxt(config.TokenTxtPath)
	csvTokens := readTokensFromCsv(config.TokenCSVPath)

	store, err := storage.ReadStore(storePath)
	if err != nil {
		store = storage.Store{}
	}
	storeTokens := storage.ListUniqueTokens(&store)

	existingTokens := parseTokenList(config.ManagementExistingKeys)

	allTokens := uniqueTokens(concatStringSlices(existingTokens, storeTokens, txtTokens, csvTokens))

	if len(allTokens) == 0 {
		return nil, errors.New("No tokens found in store.json, tokens.txt, or tokens.csv")
	}

	payload := buildPayload(allTokens)
	origin := ""
	if strings.Contains(config.ManagementURL, "://") {
		origin = strings.TrimSpace(strings.Split(config.ManagementURL, "://")[1])
		if idx := strings.Index(origin, "/"); idx > 0 {
			origin = origin[:idx]
		}
	}

	headers := map[string]string{
		"User-Agent":      "Mozilla/5.0 (X11; Linux x86_64; rv:147.0) Gecko/20100101 Firefox/147.0",
		"Accept":          "application/json, text/plain, */*",
		"Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5",
		"Content-Type":    "application/json",
		"Authorization":   "Bearer " + config.ManagementBearer,
	}
	if origin != "" {
		headers["Origin"] = origin
		headers["Referer"] = origin + "/management.html"
	}

	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPut, config.ManagementURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(res.Body)
	var responseBody interface{}
	if err := json.Unmarshal(raw, &responseBody); err != nil {
		responseBody = string(raw)
	}

	if res.StatusCode < 200 || res.StatusCode >= 300 {
		errMsg := fmt.Sprintf("Upload failed: HTTP %d", res.StatusCode)
		if rb, ok := responseBody.(string); ok {
			errMsg += " " + rb
		}
		return nil, errors.New(errMsg)
	}

	return map[string]any{
		"tokenCount":    len(allTokens),
		"body":          responseBody,
		"managementUrl": config.ManagementURL,
	}, nil
}

func readTokensFromTxt(filePath string) []string {
	if filePath == "" {
		return []string{}
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return []string{}
	}
	var tokens []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line != "" && strings.HasPrefix(line, "sk-") {
			tokens = append(tokens, line)
		}
	}
	return tokens
}

func readTokensFromCsv(filePath string) []string {
	if filePath == "" {
		return []string{}
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		return []string{}
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) < 2 {
		return []string{}
	}
	header := strings.Split(strings.ToLower(lines[0]), ",")
	tokenIdx := -1
	for i, h := range header {
		if strings.TrimSpace(h) == "token" {
			tokenIdx = i
			break
		}
	}
	if tokenIdx < 0 {
		return []string{}
	}
	var tokens []string
	for i := 1; i < len(lines); i++ {
		cols := strings.Split(lines[i], ",")
		if len(cols) > tokenIdx {
			token := strings.TrimSpace(cols[tokenIdx])
			if token != "" && strings.HasPrefix(token, "sk-") {
				tokens = append(tokens, token)
			}
		}
	}
	return tokens
}

func parseTokenList(raw string) []string {
	if raw == "" {
		return []string{}
	}
	var tokens []string
	for _, t := range strings.Split(raw, ",") {
		t = strings.TrimSpace(t)
		if t != "" && strings.HasPrefix(t, "sk-") {
			tokens = append(tokens, t)
		}
	}
	return tokens
}

func uniqueTokens(tokens []string) []string {
	seen := make(map[string]bool)
	var unique []string
	for _, t := range tokens {
		if !seen[t] {
			seen[t] = true
			unique = append(unique, t)
		}
	}
	return unique
}

func concatStringSlices(slices ...[]string) []string {
	var result []string
	for _, slice := range slices {
		result = append(result, slice...)
	}
	return result
}

func buildPayload(tokens []string) []map[string]any {
	models := make([]map[string]any, len(ProviderModels))
	for i, name := range ProviderModels {
		models[i] = map[string]any{"name": name}
	}
	return []map[string]any{
		{
			"name":            ProviderName,
			"base-url":        ProviderBaseURL,
			"api-key-entries": tokensToKeyEntries(tokens),
			"models":          models,
			"priority":        ProviderPriority,
			"test-model":      ProviderTestModel,
		},
	}
}

func tokensToKeyEntries(tokens []string) []map[string]any {
	entries := make([]map[string]any, len(tokens))
	for i, token := range tokens {
		entries[i] = map[string]any{"api-key": token}
	}
	return entries
}
