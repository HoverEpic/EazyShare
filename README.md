# EazyShare
Easy way to share files from an online server.

## Features :
 - custom urls
 - time limit option
 - count limit option
 - password protected option
 - direct download or single page
 - management via a single page
 - statistics

## Prerequisites :
 - Docker
 - Mysql 5

## Build :
./docker_build.sh

## Run :
docker run --rm --name eazyshare --hostname eazyshare -v <path-to-share>:/share -v /etc/eazyshare:/usr/src/app/config -ti epicblox/eazyshare

## Volumes :
 - /share : the main folder with files to share
 - /usr/src/app/config : the config folder

Access with http://eazyshare/share in web browser or server address and login with configured user.

## TODOs :
 - schedule remove when hit limits periodicaly
 - advanced user management
 - limit uploads
 - direct download for managers

## Plans :
 - sqlite storage (ar any non huge storage)
 - improve statistics
 - security?