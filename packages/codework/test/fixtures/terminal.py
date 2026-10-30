"""Runs a command in a pseudo-terminal: copies standard input to it, its output to standard output.

Python's own pty.spawn waits forever on macOS once the command exits, so this one polls for that.
"""

import os, pty, select, sys

pid, terminal = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

inputs = [terminal, sys.stdin.fileno()]


def copy(timeout):
    for ready in select.select(inputs, [], [], timeout)[0]:
        try:
            data = os.read(ready, 65536)
        except OSError:
            data = b""
        if not data:
            inputs.remove(ready)
        elif ready == terminal:
            os.write(sys.stdout.fileno(), data)
        else:
            os.write(terminal, data)


while True:
    copy(0.05)
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
while terminal in inputs and select.select([terminal], [], [], 0)[0]:
    copy(0)
sys.exit(os.waitstatus_to_exitcode(status))
