# hurl --variable base_url=http://127.0.0.1:4096 packages/agent/http/session.hurl

# Create a new session
POST {{base_url}}/sessions
x-codework-workspace: local
x-codework-directory: {{directory}}
{
  "name": "My New Session"
}
HTTP 200
[Asserts]
jsonpath "$.id" exists
jsonpath "$.name" == "My New Session"

# Create a child session (requires a parent ID from a previous call or hardcoded for test)
# POST {{base_url}}/sessions
# x-codework-workspace: local
# {
#   "parentSessionId": "some-session-id",
#   "name": "Child Session"
# }
# HTTP 200
