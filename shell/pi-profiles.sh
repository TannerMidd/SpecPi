# shellcheck shell=bash
# ZenPi capability profiles.

pi-core() {
  command pi --tools read,bash,edit,write,ask_user_question "$@"
}

pi-plan() {
  command pi --tools read,grep,find,ls,web_search,source_check,fetch_content,get_search_content,ask_user_question "$@"
}

pi-full() {
  command pi "$@"
}
