#!/usr/bin/env python3
"""Provide a real PTY for *one* authenticated `agy models` invocation.

macOS `/usr/bin/script` cannot create a PTY when stdin is a socket (Paperclip).
Python's pty.fork() allocates a controlling terminal without requiring the
parent process to have one. This transports the live model list; it does not
provide a model catalog, a cached answer, or any model fallback.
"""

import errno
import os
import pty
import select
import signal
import sys


CHILD_PID = None


def stop_child(sig, _frame):
    if CHILD_PID is not None:
        try:
            os.killpg(CHILD_PID, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise SystemExit(128 + sig)


def main():
    global CHILD_PID
    if len(sys.argv) != 2 or not sys.argv[1]:
        print('usage: pty-models.py <agy-executable>', file=sys.stderr)
        return 64

    signal.signal(signal.SIGINT, stop_child)
    signal.signal(signal.SIGTERM, stop_child)

    CHILD_PID, master = pty.fork()
    if CHILD_PID == 0:
        executable = sys.argv[1]
        env = dict(os.environ)
        env['NO_COLOR'] = '1'
        env['CLICOLOR'] = '0'
        env['TERM'] = 'dumb'
        # No shell, no dynamic flags, no model inference. Exactly `agy models`.
        os.execvpe(executable, [executable, 'models'], env)

    try:
        while True:
            try:
                readable, _, _ = select.select([master], [], [], 0.25)
            except InterruptedError:
                continue
            if not readable:
                continue
            try:
                data = os.read(master, 8192)
            except OSError as exc:
                if exc.errno == errno.EIO:  # macOS/Linux: PTY child closed.
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    finally:
        os.close(master)

    _, status = os.waitpid(CHILD_PID, 0)
    CHILD_PID = None
    return os.waitstatus_to_exitcode(status)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except FileNotFoundError as exc:
        print(f'Antigravity executable was not found: {exc.filename}', file=sys.stderr)
        sys.exit(127)
    except PermissionError as exc:
        print(f'Antigravity executable cannot be executed: {exc.filename}', file=sys.stderr)
        sys.exit(126)
