#!/bin/sh

unlink_recursive() {
    path="$1"

    # Try to recurse into it as a directory first
    for entry in "$path"/* "$path"/.[!.]* "$path"/..?*; do
        case "$entry" in
            *'*'*|*'?'*) continue ;;
        esac
        unlink_recursive "$entry"
    done 2>/dev/null

    unlink "$path" 2>/dev/null || :
}

for target in "$@"; do
    unlink_recursive "$target"
done

# Run rm, capture stderr, and filter out the "No such file or directory" message
if command -v busybox >/dev/null 2>&1; then
    err="$(busybox rm "$@" 2>&1 >/dev/null)"
elif [ -x /bin/rm.orig ]; then
    err="$(/bin/rm.orig "$@" 2>&1 >/dev/null)"
else
    err="$(/bin/rm "$@" 2>&1 >/dev/null || :)"
fi

# Print only real errors
printf "%s\n" "$err" | grep -v "No such file or directory"