package analytics

import (
	"context"
	"log"
	"net/url"
	"os"
	"time"

	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
)

var (
	postHogLogProvider *sdklog.LoggerProvider
	postHogLogger      otellog.Logger
)

// InitializeLogCapture configures an isolated OTel logger for the purpose-built
// PostHog logs in this package. It does not attach to the application's existing
// loggers, so only log lines introduced by this integration are exported.
func InitializeLogCapture() {
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
	endpoint, err := url.Parse(host)
	if err != nil || endpoint.Host == "" {
		log.Printf("PostHog log capture could not be initialized: invalid POSTHOG_HOST")
		return
	}

	exporter, err := otlploghttp.New(context.Background(),
		otlploghttp.WithEndpoint(endpoint.Host),
		otlploghttp.WithURLPath("/i/v1/logs"),
		otlploghttp.WithHeaders(map[string]string{"Authorization": "Bearer " + projectToken}),
	)
	if err != nil {
		log.Printf("PostHog log capture could not be initialized: %v", err)
		return
	}

	postHogLogProvider = sdklog.NewLoggerProvider(
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exporter)),
	)
	postHogLogger = postHogLogProvider.Logger("metala.posthog")
}

// LogInfo sends a purpose-built informational line to the isolated PostHog
// logger. Delivery is batched and never blocks application work.
func LogInfo(ctx context.Context, message string) {
	if postHogLogger == nil {
		return
	}

	record := otellog.Record{}
	record.SetTimestamp(time.Now())
	record.SetSeverity(otellog.SeverityInfo)
	record.SetSeverityText("INFO")
	record.SetBody(otellog.StringValue(message))
	postHogLogger.Emit(ctx, record)
}

// CloseLogCapture flushes the dedicated PostHog log pipeline on shutdown.
func CloseLogCapture() {
	if postHogLogProvider == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := postHogLogProvider.Shutdown(ctx); err != nil {
		log.Printf("PostHog log capture could not be closed: %v", err)
	}
}
