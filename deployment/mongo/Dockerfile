FROM mongo:8.2
COPY entrypoint.sh /usr/local/bin/resilliox-mongo
COPY init-app.js /docker-entrypoint-initdb.d/01-resilliox-app.js
COPY init-replica.js /opt/resilliox/init-replica.js
RUN chmod 755 /usr/local/bin/resilliox-mongo
ENTRYPOINT ["/usr/local/bin/resilliox-mongo"]
