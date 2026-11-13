FROM php:8.3-fpm-bookworm

LABEL maintainer="Housiy Platform"
LABEL description="Online Housiy platform - PHP 8.3 PHP-FPM"

# System deps + PHP extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
        libzip-dev libonig-dev unzip curl \
    && docker-php-ext-install pdo pdo_mysql mysqli opcache mbstring \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Redis and APCu extensions. Build tools are removed after compilation.
RUN apt-get update && apt-get install -y --no-install-recommends $PHPIZE_DEPS \
    && curl -fsSL --retry 5 --retry-all-errors -o /tmp/redis-6.0.2.tgz https://pecl.php.net/get/redis-6.0.2.tgz \
    && curl -fsSL --retry 5 --retry-all-errors -o /tmp/apcu-5.1.24.tgz https://pecl.php.net/get/apcu-5.1.24.tgz \
    && pecl install /tmp/redis-6.0.2.tgz \
    && pecl install /tmp/apcu-5.1.24.tgz \
    && docker-php-ext-enable redis apcu \
    && apt-get purge -y --auto-remove $PHPIZE_DEPS \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/pear /tmp/redis-6.0.2.tgz /tmp/apcu-5.1.24.tgz

# Production-oriented PHP settings. FPM pool sizing is in php-fpm-pool.conf.
RUN { \
        echo 'opcache.enable=1'; \
        echo 'opcache.enable_cli=0'; \
        echo 'opcache.memory_consumption=128'; \
        echo 'opcache.max_accelerated_files=10000'; \
        echo 'opcache.validate_timestamps=0'; \
        echo 'expose_php=0'; \
        echo 'display_errors=0'; \
        echo 'log_errors=1'; \
        echo 'session.cookie_httponly=1'; \
        echo 'session.cookie_samesite=Lax'; \
        echo 'upload_max_filesize=2M'; \
        echo 'post_max_size=4M'; \
        echo 'max_execution_time=55'; \
    } > /usr/local/etc/php/conf.d/housiy-production.ini

# The image runs as www-data, so PHP-FPM's master PID must be writable by
# that user. Keep it in /tmp rather than /run (root-owned in the base image).
RUN sed -ri 's!^;?[[:space:]]*pid[[:space:]]*=.*!pid = /tmp/php-fpm.pid!' /usr/local/etc/php-fpm.conf \
    && grep -qE '^[[:space:]]*pid[[:space:]]*=' /usr/local/etc/php-fpm.conf

# Application source
COPY src/ /var/www/html/
COPY bin/worker.php /var/www/bin/worker.php
COPY bin/status.php /var/www/bin/status.php
ENV APP_ROOT=/var/www/html

# Run PHP-FPM on TCP port 9000. Non-root operation is retained; pid/logs use
# writable /tmp and stdout/stderr. clear_env=no in the pool is required for
# DB/Redis credentials injected by Docker/Kubernetes to reach PHP scripts.
COPY deployment/docker/php-fpm-pool.conf /usr/local/etc/php-fpm.d/www.conf

RUN chown -R www-data:www-data /var/www/html /var/www/bin /tmp \
    && find /var/www/html -type d -exec chmod 755 {} \; \
    && find /var/www/html -type f -exec chmod 644 {} \; \
    && chmod 755 /var/www/bin/worker.php /var/www/bin/status.php

EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD php-fpm -t >/dev/null 2>&1 && kill -0 1

WORKDIR /var/www/html
USER www-data
CMD ["php-fpm", "-F"]
