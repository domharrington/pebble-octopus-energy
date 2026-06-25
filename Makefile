# Octopus Energy — Pebble Time 2 watchapp
#
# `pebble` comes from the Pebble SDK (uv tool install pebble-tool); it lives in
# ~/.local/bin, so make sure that's on your PATH.

PEBBLE ?= pebble
EMU    ?= emery            # emery = Pebble Time 2
PHONE  ?= $(PEBBLE_PHONE)  # your phone's IP for on-watch deploys

.DEFAULT_GOAL := help

.PHONY: help build run logs screenshot config deploy clean kill

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

deploy: build ## Install onto your watch via the phone:  make deploy PHONE=192.168.1.x
	@test -n "$(PHONE)" || { echo "Set PHONE=<phone-ip> — enable Developer Connection in the Pebble app to find it"; exit 1; }
	$(PEBBLE) install --phone $(PHONE) --logs

kill: ## Stop any running emulator
	$(PEBBLE) kill

clean: ## Remove build artifacts
	$(PEBBLE) clean
