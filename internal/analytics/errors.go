package analytics

import (
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/posthog/posthog-go"
)

// RecoverPanics reports unhandled HTTP handler panics and returns a generic
// response without allowing analytics delivery to interrupt the request.
func RecoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("unhandled HTTP panic: %v", recovered)
				if Client != nil {
					Client.Enqueue(posthog.NewDefaultException(
						time.Now(),
						"metala-server",
						"UnhandledPanic",
						fmt.Sprint(recovered),
					))
				}
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}
