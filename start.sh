#! /bin/bash

./docker_build.sh && docker run --rm -ti -v /home/vincent/git/EazyShare/share:/share -p 80:80 epicblox/eazyshare
