#!/usr/bin/env bash
# Downloads the Dockerfile's base image before the build, trying Amazon's copy
# of Docker Hub first, then Google's mirror, then Docker Hub itself (each a
# few times). Amazon's free copy sometimes refuses GitHub's shared build
# machines ("429 Too Many Requests"); once the image is here, the build uses
# it and doesn't ask any registry again.
set -uo pipefail
cd "$(dirname "$0")/../.."
IMAGE=$(awk 'toupper($1) == "FROM" { print $2; exit }' Dockerfile)
NAME=${IMAGE#public.ecr.aws/docker/library/}
for source in "$IMAGE" "mirror.gcr.io/library/$NAME" "docker.io/library/$NAME"; do
  for attempt in 1 2 3; do
    if docker pull --platform linux/amd64 "$source"; then
      [ "$source" = "$IMAGE" ] || docker tag "$source" "$IMAGE"
      echo "Base image ready (from $source)."
      exit 0
    fi
    sleep $((attempt * 10))
  done
done
echo "Couldn't download the base image $IMAGE from any registry." >&2
exit 1
