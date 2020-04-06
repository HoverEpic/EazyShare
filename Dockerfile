FROM node:carbon

RUN apt update && apt install ffmpeg -y

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install --save
# If you are building your code for production
# RUN npm install --only=production

COPY public_html public
COPY sample_config sample_config
COPY start.sh start.sh
COPY server .

RUN echo "www-data:x:33:33:www-data:/var/www:/usr/sbin/nologin" >> /etc/passwd

EXPOSE 80
CMD [ "/bin/sh", "start.sh"]