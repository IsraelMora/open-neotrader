FROM python:3.12-slim

WORKDIR /app

# Dependencias base del runner
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY runner.py .

# Plugins montados como volumen en /opt/neurotrader/plugins
ENV NEUROTRADER_PLUGINS_DIR=/opt/neurotrader/plugins
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# Sin usuario root en runtime
RUN useradd -m -u 1001 sandbox
USER sandbox

CMD ["python3", "runner.py"]
