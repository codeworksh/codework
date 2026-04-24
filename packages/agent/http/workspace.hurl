# Start the server in another shell, then run:
# hurl --variable base_url=http://127.0.0.1:4096 packages/agent/http/workspace.hurl

GET {{base_url}}/
x-codework-workspace: local
x-codework-directory: /tmp/codework-header
HTTP 200
[Asserts]
body contains "Tadaa!"

GET {{base_url}}/
x-codework-workspace: encoded-directory
x-codework-directory: %2Ftmp%2Fcodework-encoded
HTTP 200
[Asserts]
body contains "Tadaa!"
