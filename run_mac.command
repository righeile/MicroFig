#!/bin/bash
# Double-click to start MicroFigure. A copy still running on the port is
# stopped first, so the page never talks to an older server behind the
# current files.
cd "$(dirname "$0")" || exit 1
SERVER=app.py
PORT=${PORT:-5678}

# A process is ours if it is a Python whose command line names this folder's
# server, however it was started: from here, from the parent, by full path.
ours() {
    local target cwd
    target="$(pwd -P)/$SERVER"
    case "$(basename "$(ps -o comm= -p "$1")")" in [Pp]ython*) ;; *) return 1 ;; esac
    cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case " $(ps -o command= -p "$1") " in *" ${target#"$cwd"/} "*) ;; *) return 1 ;; esac
}

# Stop our old copy; step past a port some other program holds.
for _ in $(seq 20); do
    pid=$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)
    [ -z "$pid" ] && break
    if ! ours "$pid"; then PORT=$((PORT + 1)); continue; fi
    echo "Stopping the copy already running on port $PORT (pid $pid)."
    pkill -P "$pid"; kill "$pid"
    for _ in $(seq 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null
done

export PORT
exec python3 "$SERVER"  # opens the browser itself
