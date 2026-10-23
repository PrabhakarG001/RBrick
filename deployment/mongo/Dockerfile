FROM mongo:8.2
COPY entrypoint.sh /usr/local/bin/rbrick-mongo
COPY init-app.js /docker-entrypoint-initdb.d/01-rbrick-app.js
COPY init-replica.js /opt/rbrick/init-replica.js
RUN chmod 755 /usr/local/bin/rbrick-mongo
ENTRYPOINT ["/usr/local/bin/rbrick-mongo"]
