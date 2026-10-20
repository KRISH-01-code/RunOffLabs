# RunoffLab API: FastAPI + EPA SWMM (via PySWMM). Projects are stored in SQLite under /data.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    RUNOFFLAB_DB=/data/runofflab.db

WORKDIR /app
COPY pyproject.toml ./
COPY runofflab ./runofflab
RUN pip install . && mkdir -p /data

VOLUME /data
EXPOSE 8000
# Hosts such as Render and Fly set $PORT; locally it defaults to 8000.
CMD ["sh", "-c", "exec uvicorn runofflab.api.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
