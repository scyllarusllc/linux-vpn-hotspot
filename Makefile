PORT ?= 4321
URL  := http://127.0.0.1:$(PORT)

# command -> Arch package that provides it
TOOLS := node:nodejs npm:npm nmcli:networkmanager iw:iw ip:iproute2 curl:curl xdg-open:xdg-utils dnsmasq:dnsmasq sing-box:sing-box

.PHONY: dev install port80 server test flow status

## make dev: install what is missing, start the dev server, open it in the browser
dev: install
	@( for i in $$(seq 50); do curl -fs -o /dev/null $(URL)/api/health && break; sleep 0.2; done; \
	   xdg-open $(URL) >/dev/null 2>&1 ) &
	@PORT=$(PORT) node --watch-path=src --watch-path=public src/server.js

## make install: install missing system packages (pacman) and npm deps
install:
	@missing=""; \
	for t in $(TOOLS); do \
	  command -v $${t%%:*} >/dev/null 2>&1 || missing="$$missing $${t#*:}"; \
	done; \
	if [ -n "$$missing" ]; then \
	  echo "Installing:$$missing"; \
	  sudo pacman -S --needed --noconfirm $$missing; \
	else \
	  echo "System packages: all installed"; \
	fi
	@npm install --silent --no-audit --no-fund

## make port80: hotspot clients can open http://<gateway>. Only traffic to the gateway
## itself is redirected (port 80 -> $(PORT)), so the server stays unprivileged and
## clients' normal web traffic is untouched. Also restores proxy rules. Re-run after a reboot.
port80:
	@node bin/vpn-hotspot.js port80 --web-port $(PORT)

server:
	@PORT=$(PORT) node src/server.js

test:
	@npm test

flow:
	@node bin/vpn-hotspot.js flow

status:
	@node bin/vpn-hotspot.js status
