package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/sirfidely/metala/internal/platform"
)

func newServer(t *testing.T, dev bool) *httptest.Server {
	t.Helper()
	cfg := platform.DefaultConfig()
	cfg.DevMode = dev
	p := platform.New(cfg)
	if err := p.Seed(); err != nil {
		t.Fatal(err)
	}
	static := fstest.MapFS{"index.html": {Data: []byte("ok")}}
	srv := httptest.NewServer(New(p, static).Handler())
	t.Cleanup(srv.Close)
	return srv
}

func call(t *testing.T, srv *httptest.Server, method, path, token string, body any, out any) int {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if out != nil {
		_ = json.NewDecoder(res.Body).Decode(out)
	}
	return res.StatusCode
}

func staffToken(t *testing.T, srv *httptest.Server, user string) string {
	var r struct {
		Token string `json:"token"`
	}
	if code := call(t, srv, "POST", "/api/auth/staff", "", map[string]string{"username": user, "password": platform.DemoStaffPassword}, &r); code != 200 {
		t.Fatalf("login %s : %d", user, code)
	}
	return r.Token
}

func TestHTTPOperatorIsolation(t *testing.T) {
	srv := newServer(t, true)
	tok := staffToken(t, srv, "fleet@lagune.demo")
	if code := call(t, srv, "GET", "/api/fleet/vehicles?operator_id=op_ebene", tok, nil, nil); code != 403 {
		t.Fatalf("accès inter-opérateurs : %d, attendu 403", code)
	}
	var vs []map[string]any
	if code := call(t, srv, "GET", "/api/fleet/vehicles", tok, nil, &vs); code != 200 || len(vs) != 6 {
		t.Fatalf("flotte Lagune : code %d, %d véhicules", code, len(vs))
	}
	if code := call(t, srv, "GET", "/api/fleet/dashboard", "", nil, nil); code != 401 {
		t.Fatalf("sans jeton : %d, attendu 401", code)
	}
	admin := staffToken(t, srv, "admin@metala.demo")
	if code := call(t, srv, "GET", "/api/fleet/vehicles", admin, nil, &vs); code != 200 || len(vs) != 10 {
		t.Fatalf("admin : code %d, %d véhicules", code, len(vs))
	}
}

func TestHTTPWebhookSignatureRequired(t *testing.T) {
	srv := newServer(t, true)
	if code := call(t, srv, "POST", "/api/psp/webhook", "", map[string]any{"event_id": "e", "psp_ref": "x", "status": "succeeded"}, nil); code != 401 {
		t.Fatalf("webhook non signé : %d, attendu 401", code)
	}
}

func TestHTTPDevRoutesDisabledInProduction(t *testing.T) {
	srv := newServer(t, false)
	if code := call(t, srv, "GET", "/api/dev/inventory", "", nil, nil); code == 200 {
		t.Fatal("les simulateurs ne doivent pas être exposés hors mode démo")
	}
	var r map[string]any
	call(t, srv, "POST", "/api/auth/otp/request", "", map[string]string{"phone": "0707070707"}, &r)
	if _, leaked := r["dev_code"]; leaked {
		t.Fatal("le code OTP ne doit pas être renvoyé hors mode démo")
	}
}

func TestHTTPPublicVehiclesHidePlates(t *testing.T) {
	srv := newServer(t, true)
	var vs []map[string]any
	call(t, srv, "GET", "/api/vehicles", "", nil, &vs)
	for _, v := range vs {
		if v["plate"] != "" {
			t.Fatalf("immatriculation exposée publiquement : %v", v["plate"])
		}
	}
}
