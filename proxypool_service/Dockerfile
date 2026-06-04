FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY pyproject.toml ./
COPY proxypool_service ./proxypool_service
RUN pip install --no-cache-dir .

EXPOSE 40326
CMD ["shardx-proxypool", "serve"]

