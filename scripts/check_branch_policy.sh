#!/bin/sh

set -eu

base_branch=${BASE_BRANCH:-}
head_branch=${HEAD_BRANCH:-}

if [ -z "$base_branch" ] || [ -z "$head_branch" ]; then
  echo "BASE_BRANCH and HEAD_BRANCH are required."
  exit 1
fi

case "$base_branch" in
  develop)
    case "$head_branch" in
      feature/*|release_*|hotfix/*)
        ;;
      *)
        echo "Invalid pull request route: $head_branch -> $base_branch"
        echo "develop accepts feature/*, release_*, or hotfix/* branches."
        exit 1
        ;;
    esac
    ;;
  main)
    case "$head_branch" in
      release_*|hotfix/*)
        ;;
      *)
        echo "Invalid pull request route: $head_branch -> $base_branch"
        echo "main accepts only release_* or hotfix/* branches."
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Unsupported pull request base branch: $base_branch"
    exit 1
    ;;
esac

echo "Valid pull request route: $head_branch -> $base_branch"

