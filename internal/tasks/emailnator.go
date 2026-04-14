package tasks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	EmailnatorBaseURL = "https://www.emailnator.com"
	MaxRetries        = 30
	RetryIntervalMs   = 10000
)

type emailnatorClient struct {
	xsrfToken    string
	sessionToken string
	email        string
}

func newEmailnatorClient() *emailnatorClient {
	return &emailnatorClient{}
}

func (c *emailnatorClient) initSession() error {
	req, err := http.NewRequest(http.MethodGet, EmailnatorBaseURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	cookies := extractEmailnatorCookies(res.Header.Get("Set-Cookie"))
	for _, cookie := range cookies {
		if strings.HasPrefix(cookie, "XSRF-TOKEN=") {
			c.xsrfToken = strings.TrimPrefix(cookie, "XSRF-TOKEN=")
		}
		if strings.HasPrefix(cookie, "gmailnator_session=") {
			c.sessionToken = strings.TrimPrefix(cookie, "gmailnator_session=")
		}
	}
	return nil
}

func (c *emailnatorClient) generateEmail() error {
	if c.xsrfToken == "" || c.sessionToken == "" {
		if err := c.initSession(); err != nil {
			return err
		}
	}

	headers := map[string]string{
		"Accept":           "application/json, text/plain, */*",
		"Content-Type":     "application/json",
		"Origin":           EmailnatorBaseURL,
		"Referer":          EmailnatorBaseURL + "/",
		"User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
		"X-Requested-With": "XMLHttpRequest",
		"X-Xsrf-Token":     c.xsrfToken,
		"Cookie":           fmt.Sprintf("XSRF-TOKEN=%s; gmailnator_session=%s;", encodeXSRF(c.xsrfToken), c.sessionToken),
	}

	body, _ := json.Marshal(map[string]any{"email": []string{"plusGmail", "dotGmail"}})
	req, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/generate-email", bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	// Update cookies
	cookies := extractEmailnatorCookies(res.Header.Get("Set-Cookie"))
	for _, cookie := range cookies {
		if strings.HasPrefix(cookie, "XSRF-TOKEN=") {
			c.xsrfToken = strings.TrimPrefix(cookie, "XSRF-TOKEN=")
		}
		if strings.HasPrefix(cookie, "gmailnator_session=") {
			c.sessionToken = strings.TrimPrefix(cookie, "gmailnator_session=")
		}
	}

	raw, _ := io.ReadAll(res.Body)
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		return fmt.Errorf("generate email response parse failed: %v", err)
	}

	emails, ok := resp["email"].([]any)
	if !ok || len(emails) == 0 {
		return fmt.Errorf("no email in response")
	}

	c.email = fmt.Sprintf("%v", emails[0])
	log.Printf("[emailnator] generated: %s", c.email)
	return nil
}

func (c *emailnatorClient) waitForVerificationCode(baseURL string) (string, error) {
	verifyURL := strings.TrimRight(baseURL, "/") + "/api/verification?email=" + c.email + "&turnstile="

	// Send verification email
	req, err := http.NewRequest(http.MethodGet, verifyURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36")

	_, err = http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[emailnator] failed to send verification email: %v", err)
	}

	for retry := 0; retry < MaxRetries; retry++ {
		time.Sleep(time.Duration(RetryIntervalMs) * time.Millisecond)
		log.Printf("[emailnator] checking for code (attempt %d/%d)", retry+1, MaxRetries)

		code, err := c.checkInbox()
		if err != nil {
			log.Printf("[emailnator] inbox check error: %v", err)
			continue
		}
		if code != "" {
			log.Printf("[emailnator] got verification code: %s", code)
			return code, nil
		}
	}

	return "", fmt.Errorf("verification code timeout")
}

func (c *emailnatorClient) checkInbox() (string, error) {
	headers := map[string]string{
		"Accept":           "application/json, text/plain, */*",
		"Content-Type":     "application/json",
		"Origin":           EmailnatorBaseURL,
		"Referer":          EmailnatorBaseURL + "/",
		"User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
		"X-Requested-With": "XMLHttpRequest",
		"X-Xsrf-Token":     c.xsrfToken,
		"Cookie":           fmt.Sprintf("XSRF-TOKEN=%s; gmailnator_session=%s;", encodeXSRF(c.xsrfToken), c.sessionToken),
	}

	body, _ := json.Marshal(map[string]any{"email": c.email})
	req, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/message-list", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	// Update cookies
	cookies := extractEmailnatorCookies(res.Header.Get("Set-Cookie"))
	for _, cookie := range cookies {
		if strings.HasPrefix(cookie, "XSRF-TOKEN=") {
			c.xsrfToken = strings.TrimPrefix(cookie, "XSRF-TOKEN=")
		}
		if strings.HasPrefix(cookie, "gmailnator_session=") {
			c.sessionToken = strings.TrimPrefix(cookie, "gmailnator_session=")
		}
	}

	raw, _ := io.ReadAll(res.Body)
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", err
	}

	msgData, ok := resp["messageData"].([]any)
	if !ok || len(msgData) == 0 {
		return "", nil
	}

	// Find the first valid message (not ADSVPN)
	var messageID string
	for _, m := range msgData {
		msg, ok := m.(map[string]any)
		if !ok {
			continue
		}
		id, ok := msg["messageID"].(string)
		if !ok || id == "" || id == "ADSVPN" || len(id) < 5 {
			continue
		}
		messageID = id
		break
	}

	if messageID == "" {
		return "", nil
	}

	// Get message content
	body2, _ := json.Marshal(map[string]any{"email": c.email, "messageID": messageID})
	req2, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/message-list", bytes.NewReader(body2))
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req2.Header.Set(k, v)
	}

	res2, err := http.DefaultClient.Do(req2)
	if err != nil {
		return "", err
	}
	defer res2.Body.Close()

	content, _ := io.ReadAll(res2.Body)

	// Extract 6-digit code
	re := regexp.MustCompile(`(\d{6})`)
	matches := re.FindStringSubmatch(string(content))
	if len(matches) > 1 {
		return matches[1], nil
	}

	// Try alternate pattern
	re2 := regexp.MustCompile(`<strong>(\w+)</strong>`)
	matches2 := re2.FindStringSubmatch(string(content))
	if len(matches2) > 1 {
		return matches2[1], nil
	}

	return "", nil
}

func extractEmailnatorCookies(header string) []string {
	if header == "" {
		return nil
	}
	var cookies []string
	for _, part := range strings.Split(header, ";") {
		part = strings.TrimSpace(part)
		if part != "" {
			cookies = append(cookies, part)
		}
	}
	return cookies
}

func encodeXSRF(token string) string {
	return strings.ReplaceAll(token, "=", "%3D")
}
