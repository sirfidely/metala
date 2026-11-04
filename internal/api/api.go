// Package api expose le socle Metala en REST (JSON) et en flux temps réel
// (Server-Sent Events ; la cible de production est WebSocket).
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/sirfidely/metala/internal/platform"
)

type Server struct {
	p      *platform.Platform
	static fs.FS
}

func New(p *platform.Platform, static fs.FS) *Server { return &Server{p: p, static: static} }

type ctxKey struct{}

func principal(r *http.Request) (platform.Principal, bool) {
	pr, ok := r.Context().Value(ctxKey{}).(platform.Principal)
	return pr, ok
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	dev := s.p.Config().DevMode

	// Public
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "dev_mode": dev, "time": time.Now()})
	})
	mux.HandleFunc("GET /api/network", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, s.p.Network()) })
	mux.HandleFunc("GET /api/vehicles", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, publicStates(s.p.Snapshot(""))) })
	mux.HandleFunc("GET /api/stream/vehicles", s.streamVehicles)
	mux.HandleFunc("GET /api/stops/{id}/arrivals", func(w http.ResponseWriter, r *http.Request) {
		a, err := s.p.Arrivals(r.PathValue("id"))
		respond(w, a, err)
	})
	mux.HandleFunc("GET /api/products", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.p.Products(r.URL.Query().Get("operator_id")))
	})
	mux.HandleFunc("GET /api/departures", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, s.p.Departures(r.URL.Query().Get("line_id")))
	})

	// Authentification
	mux.HandleFunc("POST /api/auth/otp/request", s.otpRequest)
	mux.HandleFunc("POST /api/auth/otp/verify", s.otpVerify)
	mux.HandleFunc("POST /api/auth/staff", s.staffLogin)
	mux.HandleFunc("POST /api/auth/device", s.deviceLogin)
	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		s.p.Logout(bearer(r))
		w.WriteHeader(204)
	})

	// Voyageur
	mux.Handle("GET /api/me", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		v, err := s.p.Me(pr)
		respond(w, v, err)
	}))
	mux.Handle("GET /api/me/history", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		h, err := s.p.History(pr)
		respond(w, h, err)
	}))
	mux.Handle("POST /api/purchases", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in struct {
			ProductID string `json:"product_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		pay, err := s.p.CreatePurchase(pr, in.ProductID)
		respond(w, pay, err)
	}))
	mux.Handle("POST /api/me/cards/{uid}/block", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		respond(w, map[string]bool{"ok": true}, s.p.BlockMyCard(pr, r.PathValue("uid")))
	}))
	mux.Handle("GET /api/me/reservations", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		writeJSON(w, 200, s.p.MyReservations(pr))
	}))
	mux.Handle("POST /api/reservations", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in struct {
			DepartureID string `json:"departure_id"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		res, err := s.p.Reserve(pr, in.DepartureID)
		respond(w, res, err)
	}))
	mux.Handle("DELETE /api/reservations/{id}", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		respond(w, map[string]bool{"ok": true}, s.p.CancelReservation(pr, r.PathValue("id")))
	}))

	// PSP (webhook signé)
	mux.HandleFunc("POST /api/psp/webhook", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			writeErr(w, 400, "corps illisible")
			return
		}
		pay, err := s.p.HandlePSPWebhook(body, r.Header.Get("X-PSP-Signature"))
		respond(w, pay, err)
	})

	// Terminal Metala Scan
	mux.Handle("POST /api/scan/challenge", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		ch, exp, err := s.p.IssueChallenge(pr)
		respond(w, map[string]any{"challenge": ch, "expires_at": exp}, err)
	}))
	mux.Handle("POST /api/scan/validate", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in platform.TapRequest
		if !readJSON(w, r, &in) {
			return
		}
		v, err := s.p.Validate(pr, in)
		respond(w, v, err)
	}))
	mux.Handle("GET /api/scan/config", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		c, err := s.p.ScanConfig(pr)
		respond(w, c, err)
	}))
	mux.Handle("POST /api/scan/offline-sync", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in struct {
			Txs []platform.OfflineTx `json:"txs"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		res, err := s.p.OfflineSync(pr, in.Txs)
		respond(w, res, err)
	}))
	mux.Handle("POST /api/telemetry", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in platform.TelemetryInput
		if !readJSON(w, r, &in) {
			return
		}
		respond(w, map[string]bool{"ok": true}, s.p.IngestTelemetry(pr, in))
	}))

	// Metala Fleet (isolation stricte par opérateur)
	op := func(r *http.Request) string { return r.URL.Query().Get("operator_id") }
	mux.Handle("GET /api/fleet/dashboard", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		d, err := s.p.Dashboard(pr, op(r))
		respond(w, d, err)
	}))
	mux.Handle("GET /api/fleet/vehicles", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		v, err := s.p.FleetVehicles(pr, op(r))
		respond(w, v, err)
	}))
	mux.Handle("GET /api/fleet/validations", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		v, err := s.p.FleetValidations(pr, op(r), limit)
		respond(w, v, err)
	}))
	mux.Handle("GET /api/fleet/reconciliation", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		rc, err := s.p.Reconcile(pr, op(r))
		respond(w, rc, err)
	}))
	mux.Handle("POST /api/fleet/devices/{id}/freeze", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		var in struct {
			Frozen bool `json:"frozen"`
		}
		if !readJSON(w, r, &in) {
			return
		}
		respond(w, map[string]bool{"ok": true}, s.p.FreezeDevice(pr, r.PathValue("id"), in.Frozen))
	}))
	mux.Handle("POST /api/admin/cards/{uid}/revoke", s.auth(func(w http.ResponseWriter, r *http.Request, pr platform.Principal) {
		respond(w, map[string]bool{"ok": true}, s.p.RevokeCard(pr, r.PathValue("uid")))
	}))

	// Simulateurs (mode démonstration uniquement)
	if dev {
		mux.HandleFunc("GET /api/dev/inventory", func(w http.ResponseWriter, r *http.Request) {
			devs, cards := s.p.DevInventory()
			writeJSON(w, 200, map[string]any{"devices": devs, "cards": cards,
				"staff":          []string{"fleet@lagune.demo", "fleet@ebene.demo", "admin@metala.demo"},
				"staff_password": platform.DemoStaffPassword})
		})
		mux.HandleFunc("POST /api/dev/reset", func(w http.ResponseWriter, r *http.Request) {
			respond(w, map[string]bool{"ok": true}, s.p.Reset())
		})
		mux.HandleFunc("POST /api/dev/cards/{uid}/respond", func(w http.ResponseWriter, r *http.Request) {
			var in struct {
				Challenge string `json:"challenge"`
			}
			if !readJSON(w, r, &in) {
				return
			}
			proof, err := s.p.SimulateCard(strings.ToUpper(r.PathValue("uid")), in.Challenge)
			respond(w, map[string]string{"proof": proof}, err)
		})
		// Joue le rôle de la puce lors d'un débit hors ligne par le valideur.
		mux.HandleFunc("POST /api/dev/cards/{uid}/offline-debit", func(w http.ResponseWriter, r *http.Request) {
			var in struct {
				DeviceID string `json:"device_id"`
				Amount   int64  `json:"amount"`
			}
			if !readJSON(w, r, &in) {
				return
			}
			tx, err := s.p.ChipOfflineDebit(r.PathValue("uid"), in.DeviceID, in.Amount)
			respond(w, tx, err)
		})
		mux.HandleFunc("POST /api/dev/psp/{id}/confirm", func(w http.ResponseWriter, r *http.Request) {
			status := r.URL.Query().Get("status")
			if status == "" {
				status = "succeeded"
			}
			pay, err := s.p.SimulatePSP(r.PathValue("id"), status, r.URL.Query().Get("duplicate") == "1")
			respond(w, pay, err)
		})
	}

	mux.Handle("/", http.FileServerFS(s.static))
	return securityHeaders(logRequests(mux))
}

// publicStates retire les données d'exploitation non publiques.
func publicStates(in []platform.VehicleState) []platform.VehicleState {
	for i := range in {
		in[i].Plate = ""
		in[i].DeviceFrozen = false
	}
	return in
}

func (s *Server) streamVehicles(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, 500, "streaming non supporté")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	send := func() bool {
		b, _ := json.Marshal(publicStates(s.p.Snapshot("")))
		if _, err := w.Write([]byte("event: vehicles\ndata: " + string(b) + "\n\n")); err != nil {
			return false
		}
		fl.Flush()
		return true
	}
	if !send() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-t.C:
			if !send() {
				return
			}
		}
	}
}

func (s *Server) otpRequest(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	phone, code, err := s.p.RequestOTP(in.Phone)
	if err != nil {
		respond(w, nil, err)
		return
	}
	out := map[string]any{"phone": phone, "sent": true}
	if s.p.Config().DevMode {
		out["dev_code"] = code // prototype : pas d'envoi SMS
	}
	writeJSON(w, 200, out)
}

func (s *Server) otpVerify(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
		Name  string `json:"name"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tok, t, err := s.p.VerifyOTP(in.Phone, in.Code, in.Name)
	respond(w, map[string]any{"token": tok, "traveler": t}, err)
}

func (s *Server) staffLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tok, pr, err := s.p.StaffLogin(in.Username, in.Password)
	respond(w, map[string]any{"token": tok, "principal": pr}, err)
}

func (s *Server) deviceLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceID string `json:"device_id"`
		Secret   string `json:"secret"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tok, pr, err := s.p.DeviceLogin(in.DeviceID, in.Secret)
	respond(w, map[string]any{"token": tok, "principal": pr}, err)
}

// --- utilitaires HTTP ---

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return ""
}

func (s *Server) auth(h func(http.ResponseWriter, *http.Request, platform.Principal)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pr, err := s.p.Authenticate(bearer(r))
		if err != nil {
			respond(w, nil, err)
			return
		}
		h(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, pr)), pr)
	})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeErr(w, 400, "JSON invalide : "+err.Error())
		return false
	}
	return true
}

func respond(w http.ResponseWriter, v any, err error) {
	if err == nil {
		writeJSON(w, 200, v)
		return
	}
	switch {
	case errors.Is(err, platform.ErrNotFound):
		writeErr(w, 404, err.Error())
	case errors.Is(err, platform.ErrUnauthorized):
		writeErr(w, 401, err.Error())
	case errors.Is(err, platform.ErrForbidden):
		writeErr(w, 403, err.Error())
	case errors.Is(err, platform.ErrInvalid):
		writeErr(w, 400, err.Error())
	case errors.Is(err, platform.ErrConflict):
		writeErr(w, 409, err.Error())
	default:
		log.Printf("erreur interne : %v", err)
		writeErr(w, 500, "erreur interne")
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// OpenStreetMap exige un Referer sur les requêtes de tuiles : on envoie
		// l'origine (sans chemin) aux sites tiers.
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN") // la démo guidée intègre App, Scan et Fleet
		h.ServeHTTP(w, r)
	})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/stream/vehicles" && r.Method != http.MethodGet {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}
