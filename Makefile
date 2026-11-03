.PHONY: run test vet build docker

run:
	go run ./cmd/metala

test:
	go test -race ./...

vet:
	gofmt -l . && go vet ./...

build:
	CGO_ENABLED=0 go build -o bin/metala ./cmd/metala

docker:
	docker build -t metala .
