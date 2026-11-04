// Commande metala : lance le prototype (API + simulateurs + interfaces web).
package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/sirfidely/metala/internal/api"
	"github.com/sirfidely/metala/internal/platform"
	"github.com/sirfidely/metala/internal/sim"
	"github.com/sirfidely/metala/web"
)

func main() {
	addr := flag.String("addr", envOr("METALA_ADDR", ":8080"), "adresse d'écoute")
	simulate := flag.Bool("sim", true, "activer le simulateur GPS de démonstration")
	riders := flag.Bool("riders", true, "simuler des montées de voyageurs fictifs")
	webDir := flag.String("web-dir", "", "servir les interfaces depuis ce dossier (développement) au lieu des fichiers intégrés")
	flag.Parse()

	cfg := platform.DefaultConfig()
	if os.Getenv("METALA_ENV") == "production" {
		cfg.DevMode = false
		cfg.CardMasterKey = mustEnv("METALA_CARD_MASTER_KEY")
		cfg.PSPWebhookSecret = mustEnv("METALA_PSP_WEBHOOK_SECRET")
	}
	p := platform.New(cfg)
	if err := p.Seed(); err != nil {
		log.Fatalf("seed : %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if *simulate && cfg.DevMode {
		go sim.Run(ctx, p, *riders)
	}

	static := web.Static()
	if *webDir != "" {
		static = os.DirFS(*webDir)
	}
	srv := &http.Server{Addr: *addr, Handler: api.New(p, static).Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
	}()
	log.Printf("Metala prototype sur http://localhost%s (mode démo : %v)", *addr, cfg.DevMode)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func mustEnv(k string) []byte {
	v := os.Getenv(k)
	if len(v) < 32 {
		log.Fatalf("%s doit être défini (≥ 32 caractères) en production", k)
	}
	return []byte(v)
}
