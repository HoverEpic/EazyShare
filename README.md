# EazyShare
Easy way to share files from an online server.

## Features :
 - custom urls
 - time limit option
 - count limit option
 - password protected option
 - direct download or sigle page
 - management via a single page
 - statistics

## Prerequisites :
 - Docker

## Build :
./docker_build.sh

## Run :
docker run --rm --name eazyshare --hostname eazyshare -v <path-to-share>:/share -ti epicblox/eazyshare

## Volumes :
 - /share : the main folder with files to share
 - /usr/src/app/config : the config folder

Access with http://eazyshare/ in web browser.

## Plans :
 - sqlite storage
 - user management
 - improve statistics
 - security?