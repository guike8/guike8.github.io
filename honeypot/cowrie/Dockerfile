# Cowrie release and its core dependencies are pinned by the upstream package.
FROM python:3.13-slim-bookworm@sha256:a5a7017efc5969e00ae2b91c8eb0631049a569652aa4ffc4501769049ae45c72
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 TZ=UTC
COPY requirements.lock /opt/requirements.lock
RUN python -m pip install --no-cache-dir -r /opt/requirements.lock \
    && groupadd --gid 10001 cowrie \
    && useradd --uid 10001 --gid 10001 --home-dir /cowrie --no-create-home cowrie
WORKDIR /cowrie
COPY . /opt/observatory/
RUN python -c 'import pathlib, shutil, cowrie.output; shutil.copyfile("/opt/observatory/observatory.py", pathlib.Path(next(iter(cowrie.output.__path__))) / "observatory.py")' \
    && mkdir -p /cowrie/etc /cowrie/var/log/cowrie /cowrie/var/lib/cowrie/downloads /cowrie/var/lib/cowrie/snapshots /cowrie/var/lib/cowrie/tty /cowrie/var/run \
    && cp /opt/observatory/cowrie.cfg /cowrie/etc/cowrie.cfg \
    && cp /opt/observatory/userdb.txt /cowrie/etc/userdb.txt \
    && python /opt/observatory/prepare_fs.py \
    && chown -R 10001:10001 /cowrie
USER 10001:10001
EXPOSE 2222
STOPSIGNAL SIGTERM
ENTRYPOINT ["python", "/opt/observatory/start.py"]
