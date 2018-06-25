FROM node:carbon

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
COPY config config
COPY server .

EXPOSE 80
CMD [ "npm", "start" ]