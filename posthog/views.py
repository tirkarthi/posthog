import os
from functools import wraps
from typing import Dict, Union

import sentry_sdk
from django.conf import settings
from django.contrib.auth import login
from django.contrib.auth.decorators import login_required as base_login_required
from django.db import DEFAULT_DB_ALIAS, connections
from django.db.migrations.executor import MigrationExecutor
from django.http import HttpRequest, HttpResponse, JsonResponse
from django.shortcuts import redirect
from django.views.decorators.cache import never_cache

from posthog.ee import is_clickhouse_enabled
from posthog.email import is_email_available
from posthog.models import User
from posthog.utils import (
    get_available_social_auth_providers,
    get_available_timezones_with_offsets,
    get_celery_heartbeat,
    is_celery_alive,
    is_plugin_server_alive,
    is_postgres_alive,
    is_redis_alive,
)
from posthog.version import VERSION

ROBOTS_TXT_CONTENT = "User-agent: *\nDisallow: /"


def noop(*args, **kwargs) -> None:
    return None


try:
    from ee.models.license import get_licensed_users_available
except ImportError:
    get_licensed_users_available = noop


def login_required(view):
    base_handler = base_login_required(view)

    @wraps(view)
    def handler(request, *args, **kwargs):
        if not User.objects.exists():
            return redirect("/preflight")
        elif not request.user.is_authenticated and settings.AUTO_LOGIN:
            user = User.objects.first()
            login(request, user, backend="django.contrib.auth.backends.ModelBackend")
        return base_handler(request, *args, **kwargs)

    return handler


def health(request):
    executor = MigrationExecutor(connections[DEFAULT_DB_ALIAS])
    plan = executor.migration_plan(executor.loader.graph.leaf_nodes())
    status = 503 if plan else 200
    if status == 503:
        err = Exception("Migrations are not up to date. If this continues migrations have failed")
        sentry_sdk.capture_exception(err)
        return HttpResponse("Migrations are not up to date", status=status, content_type="text/plain")
    if status == 200:
        return HttpResponse("ok", status=status, content_type="text/plain")


def stats(request):
    stats_response: Dict[str, Union[int, str]] = {}
    stats_response["worker_heartbeat"] = get_celery_heartbeat()
    return JsonResponse(stats_response)


def robots_txt(request):
    return HttpResponse(ROBOTS_TXT_CONTENT, content_type="text/plain")


@never_cache
def preflight_check(request: HttpRequest) -> JsonResponse:

    response = {
        "django": True,
        "redis": is_redis_alive() or settings.TEST,
        "plugins": is_plugin_server_alive() or settings.TEST,
        "celery": is_celery_alive() or settings.TEST,
        "db": is_postgres_alive(),
        "initiated": User.objects.exists() if not settings.E2E_TESTING else False,  # Enables E2E testing of signup flow
        "cloud": settings.MULTI_TENANCY,
        "available_social_auth_providers": get_available_social_auth_providers(),
    }

    if request.user.is_authenticated:
        response = {
            **response,
            "ee_available": settings.EE_AVAILABLE,
            "is_clickhouse_enabled": is_clickhouse_enabled(),
            "db_backend": settings.PRIMARY_DB.value,
            "available_timezones": get_available_timezones_with_offsets(),
            "opt_out_capture": os.environ.get("OPT_OUT_CAPTURE", False),
            "posthog_version": VERSION,
            "email_service_available": is_email_available(with_absolute_urls=True),
            "is_debug": settings.DEBUG,
            "is_event_property_usage_enabled": settings.ASYNC_EVENT_PROPERTY_USAGE,
            "licensed_users_available": get_licensed_users_available(),
            "site_url": settings.SITE_URL,
        }

    return JsonResponse(response)
