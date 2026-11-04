// Commande metala : lance le prototype (API + simulateurs + interfaces web).
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"flag"
	"log"
	"math/big"
	"net"
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
	useTLS := flag.Bool("https", false, "HTTPS avec un certificat auto-signé (la caméra des téléphones l'exige)")
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
	if *useTLS {
		cert, err := selfSigned()
		if err != nil {
			log.Fatal(err)
		}
		srv.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		log.Printf("Metala sur https://localhost%s — sur un téléphone du même réseau : https://<adresse-IP-de-cet-ordinateur>%s", *addr, *addr)
		for _, ip := range lanIPs() {
			log.Printf("  https://%s%s", ip, *addr)
		}
		if err := srv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
		return
	}
	log.Printf("Metala sur http://localhost%s", *addr)
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

// selfSigned génère un certificat éphémère pour localhost et les adresses du réseau local.
func selfSigned() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "Metala (prototype)"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(30 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{"localhost"},
		IPAddresses:  append([]net.IP{net.ParseIP("127.0.0.1")}, lanIPs()...),
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

func lanIPs() []net.IP {
	var out []net.IP
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			out = append(out, n.IP)
		}
	}
	return out
}
