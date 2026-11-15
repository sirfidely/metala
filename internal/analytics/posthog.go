// Package analytics configures the process-wide PostHog client.
package analytics

import (
	"log"
	"os"

	"github.com/posthog/posthog-go"
)

// Client is initialized once by the application entry point. Call sites must
// guard it for nil so missing analytics configuration never affects app work.
var Client posthog.Client

// Initialize creates the one PostHog client used by this process.
func Initialize() {
	projectToken := os.Getenv("POSTHOG_PROJECT_TOKEN")
	if projectToken == "" {
		warnMissing("POSTHOG_PROJECT_TOKEN")
		return
	}

	host := os.Getenv("POSTHOG_HOST")
	if host == "" {
		warnMissing("POSTHOG_HOST")
		return
	}

	client, err := posthog.NewWithConfig(projectToken, posthog.Config{Endpoint: host})
	if err != nil {
		log.Printf("PostHog client could not be initialized: %v", err)
		return
	}
	Client = client
}

// Identify associates a stable user ID with person properties. It is safe to
// call from an authentication boundary when analytics is not configured.
func Identify(distinctID string, personProperties map[string]any) {
	if Client == nil || distinctID == "" {
		return
	}

	properties := posthog.NewProperties()
	for key, value := range personProperties {
		properties.Set(key, value)
	}
	Client.Enqueue(posthog.Identify{
		DistinctId: distinctID,
		Properties: properties,
	})
}

// Capture enqueues a business event without allowing analytics configuration
// or delivery to affect the calling workflow.
func Capture(distinctID, event string, eventProperties map[string]any) {
	if Client == nil || distinctID == "" {
		return
	}

	properties := posthog.NewProperties()
	for key, value := range eventProperties {
		properties.Set(key, value)
	}
	Client.Enqueue(posthog.Capture{
		DistinctId: distinctID,
		Event:      event,
		Properties: properties,
	})
}

// Close flushes queued analytics before the process exits.
func Close() {
	if Client == nil {
		return
	}
	if err := Client.Close(); err != nil {
		log.Printf("PostHog client could not be closed: %v", err)
	}
}

func warnMissing(name string) {
	if os.Getenv("METALA_ENV") == "production" {
		return
	}
	log.Printf("WARNING: %s variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once %s is configured", name, name)
}
