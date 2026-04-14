package tasks

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
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
	client *http.Client
	email  string
}

func newEmailnatorClient() *emailnatorClient {
	jar, _ := cookiejar.New(nil)
	return &emailnatorClient{
		client: &http.Client{Jar: jar},
	}
}

func (c *emailnatorClient) initSession() error {
	req, err := http.NewRequest(http.MethodGet, EmailnatorBaseURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")

	res, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return nil
}

func (c *emailnatorClient) getCookie(name string) string {
	u, _ := url.Parse(EmailnatorBaseURL)
	for _, cookie := range c.client.Jar.Cookies(u) {
		if cookie.Name == name {
			return cookie.Value
		}
	}
	return ""
}

func (c *emailnatorClient) generateEmail() error {
	if err := c.initSession(); err != nil {
		return err
	}

	xsrf := c.getCookie("XSRF-TOKEN")
	sesh := c.getCookie("gmailnator_session")
	if xsrf == "" || sesh == "" {
		return fmt.Errorf("no cookies after init")
	}

	xsrfDecoded := strings.ReplaceAll(xsrf, "%3D", "=")

	headers := map[string]string{
		"Accept":           "application/json, text/plain, */*",
		"Content-Type":     "application/json",
		"Origin":           EmailnatorBaseURL,
		"Referer":          EmailnatorBaseURL + "/",
		"User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
		"X-Requested-With": "XMLHttpRequest",
		"X-Xsrf-Token":     xsrfDecoded,
		"Cookie":           fmt.Sprintf("XSRF-TOKEN=%s; gmailnator_session=%s;", xsrf, sesh),
	}

	body, _ := json.Marshal(map[string]any{"email": []string{"plusGmail", "dotGmail"}})
	req, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/generate-email", bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := c.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(res.Body)
	log.Printf("[emailnator] generate response: %s", string(raw))

	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		return fmt.Errorf("parse failed: %v, raw: %s", err, string(raw))
	}

	emails, ok := resp["email"].([]any)
	if !ok || len(emails) == 0 {
		return fmt.Errorf("no email in response: %v", resp)
	}

	c.email = fmt.Sprintf("%v", emails[0])
	log.Printf("[emailnator] generated: %s", c.email)
	return nil
}

func (c *emailnatorClient) waitForVerificationCode(baseURL string) (string, error) {
	verifyURL := strings.TrimRight(baseURL, "/") + "/api/verification?email=" + c.email + "&turnstile="
	log.Printf("[emailnator] sending verification request to: %s", verifyURL)

	req, err := http.NewRequest(http.MethodGet, verifyURL, nil)
	if err != nil {
		log.Printf("[emailnator] failed to create verification request: %v", err)
		return "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36")

	res, err := c.client.Do(req)
	if err != nil {
		log.Printf("[emailnator] failed to send verification email: %v", err)
		return "", err
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(res.Body)
	log.Printf("[emailnator] verification response: %s", string(raw))

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
	xsrf := c.getCookie("XSRF-TOKEN")
	sesh := c.getCookie("gmailnator_session")
	if xsrf == "" || sesh == "" {
		return "", fmt.Errorf("no cookies")
	}

	xsrfDecoded := strings.ReplaceAll(xsrf, "%3D", "=")

	headers := map[string]string{
		"Accept":           "application/json, text/plain, */*",
		"Content-Type":     "application/json",
		"Origin":           EmailnatorBaseURL,
		"Referer":          EmailnatorBaseURL + "/",
		"User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
		"X-Requested-With": "XMLHttpRequest",
		"X-Xsrf-Token":     xsrfDecoded,
		"Cookie":           fmt.Sprintf("XSRF-TOKEN=%s; gmailnator_session=%s;", xsrf, sesh),
	}

	body, _ := json.Marshal(map[string]any{"email": c.email})
	req, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/message-list", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	res, err := c.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(res.Body)
	var resp map[string]any
	if err := json.Unmarshal(raw, &resp); err != nil {
		return "", err
	}

	msgData, ok := resp["messageData"].([]any)
	if !ok || len(msgData) == 0 {
		return "", nil
	}

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

	body2, _ := json.Marshal(map[string]any{"email": c.email, "messageID": messageID})
	req2, err := http.NewRequest(http.MethodPost, EmailnatorBaseURL+"/message-list", bytes.NewReader(body2))
	if err != nil {
		return "", err
	}
	for k, v := range headers {
		req2.Header.Set(k, v)
	}

	res2, err := c.client.Do(req2)
	if err != nil {
		return "", err
	}
	defer res2.Body.Close()

	content, _ := io.ReadAll(res2.Body)

	re := regexp.MustCompile(`(\d{6})`)
	matches := re.FindStringSubmatch(string(content))
	if len(matches) > 1 {
		return matches[1], nil
	}

	return "", nil
}
