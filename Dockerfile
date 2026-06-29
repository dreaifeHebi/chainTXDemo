FROM nginx:1.27-alpine

COPY index.html /usr/share/nginx/html/index.html
COPY src /usr/share/nginx/html/src
COPY README.md /usr/share/nginx/html/README.md
COPY network_params.yaml /usr/share/nginx/html/network_params.yaml
