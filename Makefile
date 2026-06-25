# Octopus Energy — Pebble Time 2 watchapp
#
# `pebble` comes from the Pebble SDK (uv tool install pebble-tool); it lives in
# ~/.local/bin, so make sure that's on your PATH.

PEBBLE ?= pebble
EMU    ?= emery            # emery = Pebble Time 2
PHONE  ?=                  # set to your phone's IP for the legacy local-WiFi route

.DEFAULT_GOAL := help

.PHONY: help build run logs screenshot config login deploy deploy-ip clean kill

help: ## Show this help
	@grep -E '^[a-z]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## Build the app (all target platforms)
	$(PEBBLE) build

run: build ## Build + launch the Pebble Time 2 emulator with logs
	$(PEBBLE) install --emulator $(EMU) --logs

logs: ## Stream logs from the running emulator/watch
	$(PEBBLE) logs

screenshot: ## Save a screenshot of the running emulator
	$(PEBBLE) screenshot

config: ## Open the on-phone Settings page in the emulator
	$(PEBBLE) emu-app-config --emulator $(EMU)

pbw: build ## No-cloud: build the .pbw, then sideload it via your phone (AirDrop / Sideload Helper)
	@echo "Sideload this onto your watch (open it in the Pebble app):"
	@echo "  $(CURDIR)/build/octopus.pbw"
	@command -v open >/dev/null 2>&1 && open -R build/octopus.pbw || true

login: ## Sign the CLI into your Rebble/CloudPebble account (one-time, for `deploy`)
	$(PEBBLE) login

deploy: build ## Install via the CloudPebble dev connection (needs `make login`)
	$(PEBBLE) install --cloudpebble --logs

deploy-ip: build ## Install over local Wi-Fi, no cloud: make deploy-ip PHONE=192.168.1.x
	@test -n "$(PHONE)" || { echo "Set PHONE=<phone-ip> (only if the app shows a Server IP)"; exit 1; }
	$(PEBBLE) install --phone $(PHONE) --logs

kill: ## Stop any running emulator
	$(PEBBLE) kill

clean: ## Remove build artifacts
	$(PEBBLE) clean
