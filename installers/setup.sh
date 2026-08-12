#!/usr/bin/env bash
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[0;33m"
RESET="\033[0m"

info()  { echo -e "${CYAN}[opoclaw]${RESET} $*"; }
ok()    { echo -e "${GREEN}[✓]${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
header(){ echo -e "\n${BOLD}═══ $* ═══${RESET}\n"; }

REPO_URL="https://github.com/oponic/opoclaw.git"
INSTALL_DIR="$HOME/Documents/opoclaw"

detect_os() {
    case "$(uname -s)" in
        Darwin)  echo "macos" ;;
        Linux)   echo "linux" ;;
        *)       echo "unknown" ;;
    esac
}

OS=$(detect_os)
if [ "$OS" = "unknown" ]; then
    echo "Error: unsupported OS $(uname -s)."
    exit 1
fi

header "opoclaw installer ($OS)"

# ── Package managers ────────────────────────────────────────────────────────

install_deno() {
    if command -v deno &>/dev/null; then
        ok "Deno already installed ($(deno --version | head -1))"
        return
    fi
    info "Installing Deno (required)..."
    curl -fsSL https://deno.land/install.sh | sh
    export PATH="$HOME/.deno/bin:$PATH"
    if command -v deno &>/dev/null; then
        ok "Deno installed ($(deno --version | head -1))"
    else
        echo "Error: Deno install failed."
        exit 1
    fi
}

install_bun() {
    if command -v bun &>/dev/null; then
        ok "Bun already installed ($(bun --version))"
        return
    fi
    info "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if command -v bun &>/dev/null; then
        ok "Bun installed ($(bun --version))"
    else
        echo "Error: bun install failed."
        exit 1
    fi
}

ensure_git() {
    if command -v git &>/dev/null; then
        ok "Git already installed"
        return
    fi
    info "Installing git..."
    case "$OS" in
        macos) xcode-select --install 2>/dev/null || true ;;
        linux)
            if command -v apt &>/dev/null; then
                sudo apt update && sudo apt install -y git
            elif command -v dnf &>/dev/null; then
                sudo dnf install -y git
            elif command -v pacman &>/dev/null; then
                sudo pacman -S --noconfirm git
            else
                echo "Error: couldn't detect package manager."
                exit 1
            fi
            ;;
    esac
    ok "Git installed"
}

# ── Clone (latest tag) ─────────────────────────────────────────────────────

clone_repo() {
    if [ -d "$INSTALL_DIR" ]; then
        ok "opoclaw already exists at $INSTALL_DIR — pulling latest"
        cd "$INSTALL_DIR"
        git fetch --tags
        git checkout main 2>/dev/null || git checkout -b main
        git pull --rebase
        # Checkout latest tag
        LATEST_TAG=$(git tag --sort=-v:refname | head -1)
        if [ -n "$LATEST_TAG" ]; then
            info "Checking out latest tag: $LATEST_TAG"
            git checkout "$LATEST_TAG"
        fi
        return
    fi

    info "Cloning opoclaw (latest tag)..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    LATEST_TAG=$(git tag --sort=-v:refname | head -1)
    if [ -n "$LATEST_TAG" ]; then
        info "Checking out latest tag: $LATEST_TAG"
        git checkout "$LATEST_TAG"
    fi
    ok "Repo cloned"
}

install_deps() {
    info "Installing dependencies..."
    cd "$INSTALL_DIR"
    bun install
    ok "Dependencies installed"
}

# ── Main ────────────────────────────────────────────────────────────────────

header "Checking dependencies"
ensure_git
install_bun
install_deno

header "Setting up opoclaw"
clone_repo
install_deps

header "Installing opoclaw command"
bun run src/cli.ts install --service

header "Launching onboard wizard"
cd "$INSTALL_DIR"
# When this script is run via `curl … | bash`, stdin is the piped script, not the
# terminal, so the wizard's prompts would read EOF. Redirect from /dev/tty when
# it's available so onboarding stays interactive; otherwise skip and let the user
# run `opoclaw onboard` themselves.
if [ -r /dev/tty ]; then
    bun run installers/onboard.ts < /dev/tty
else
    warn "No interactive terminal detected — skipping onboarding."
    warn "Run 'opoclaw onboard' to configure opoclaw."
fi

echo ""
ok "opoclaw is installed!"
echo "  Start:    opoclaw gateway start"
echo "  Usage:    opoclaw usage"
echo "  Update:   opoclaw update"
echo "  Help:     opoclaw help"
echo ""
