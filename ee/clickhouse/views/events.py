import json
from datetime import timedelta
from typing import Any, Dict, List, Optional, Union

from django.utils.timezone import now
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from ee.clickhouse.client import sync_execute
from ee.clickhouse.models.action import format_action_filter
from ee.clickhouse.models.event import ClickhouseEventSerializer, determine_event_conditions
from ee.clickhouse.models.person import get_persons_by_distinct_ids
from ee.clickhouse.models.property import get_property_values_for_key, parse_prop_clauses
from ee.clickhouse.queries.clickhouse_session_recording import SessionRecording
from ee.clickhouse.queries.sessions.list import ClickhouseSessionsList
from ee.clickhouse.sql.events import (
    GET_CUSTOM_EVENTS,
    SELECT_EVENT_WITH_ARRAY_PROPS_SQL,
    SELECT_EVENT_WITH_PROP_SQL,
    SELECT_ONE_EVENT_SQL,
)
from posthog.api.event import EventViewSet
from posthog.models import Filter, Person, Team
from posthog.models.action import Action
from posthog.models.filters.sessions_filter import SessionsFilter
from posthog.models.session_recording_event import SessionRecordingViewed
from posthog.models.utils import UUIDT
from posthog.utils import convert_property_value, flatten


class ClickhouseEventsViewSet(EventViewSet):

    serializer_class = ClickhouseEventSerializer  # type: ignore

    def _get_people(self, query_result: List[Dict], team: Team) -> Dict[str, Any]:
        distinct_ids = [event[5] for event in query_result]
        persons = get_persons_by_distinct_ids(team.pk, distinct_ids)
        distinct_to_person: Dict[str, Person] = {}
        for person in persons:
            for distinct_id in person.distinct_ids:
                distinct_to_person[distinct_id] = person
        return distinct_to_person

    def _query_events_list(
        self, filter: Filter, team: Team, request: Request, long_date_from: bool = False, limit: int = 100
    ) -> List:
        limit_sql = f"LIMIT {limit + 1}"
        conditions, condition_params = determine_event_conditions(
            team,
            {
                "after": (now() - timedelta(days=1)).isoformat(),
                "before": (now() + timedelta(seconds=5)).isoformat(),
                **request.GET.dict(),
            },
            long_date_from,
        )
        prop_filters, prop_filter_params = parse_prop_clauses(filter.properties, team.pk)

        if request.GET.get("action_id"):
            try:
                action = Action.objects.get(pk=request.GET["action_id"], team_id=team.pk)
            except Action.DoesNotExist:
                return []
            if action.steps.count() == 0:
                return []
            action_query, params = format_action_filter(action)
            prop_filters += " AND {}".format(action_query)
            prop_filter_params = {**prop_filter_params, **params}

        if prop_filters != "":
            return sync_execute(
                SELECT_EVENT_WITH_PROP_SQL.format(conditions=conditions, limit=limit_sql, filters=prop_filters),
                {"team_id": team.pk, **condition_params, **prop_filter_params},
            )
        else:
            return sync_execute(
                SELECT_EVENT_WITH_ARRAY_PROPS_SQL.format(conditions=conditions, limit=limit_sql),
                {"team_id": team.pk, **condition_params},
            )

    def list(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        is_csv_request = self.request.accepted_renderer.format == "csv"
        limit = self.CSV_EXPORT_LIMIT if is_csv_request else 100

        team = self.team
        filter = Filter(request=request)

        query_result = self._query_events_list(filter, team, request, limit=limit)

        # Retry the query without the 1 day optimization
        if len(query_result) < limit and not request.GET.get("after"):
            query_result = self._query_events_list(filter, team, request, long_date_from=True, limit=limit)

        result = ClickhouseEventSerializer(
            query_result[0:limit], many=True, context={"people": self._get_people(query_result, team),},
        ).data

        next_url: Optional[str] = None
        if not is_csv_request and len(query_result) > 100:
            path = request.get_full_path()
            reverse = request.GET.get("orderBy", "-timestamp") != "-timestamp"
            next_url = request.build_absolute_uri(
                "{}{}{}={}".format(
                    path,
                    "&" if "?" in path else "?",
                    "after" if reverse else "before",
                    query_result[99][3].strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
                )
            )

        return Response({"next": next_url, "results": result})

    def retrieve(self, request: Request, pk: Optional[Union[int, str]] = None, *args: Any, **kwargs: Any) -> Response:
        if not isinstance(pk, str) or not UUIDT.is_valid_uuid(pk):
            return Response({"detail": "Invalid UUID", "code": "invalid", "type": "validation_error",}, status=400)
        query_result = sync_execute(SELECT_ONE_EVENT_SQL, {"team_id": self.team.pk, "event_id": pk.replace("-", "")})
        if len(query_result) == 0:
            raise NotFound(detail=f"No events exist for event UUID {pk}")
        res = ClickhouseEventSerializer(query_result[0], many=False).data
        return Response(res)

    @action(methods=["GET"], detail=False)
    def values(self, request: Request, **kwargs) -> Response:
        key = request.GET.get("key")
        team = self.team
        result = []
        flattened = []
        if key == "custom_event":
            events = sync_execute(GET_CUSTOM_EVENTS, {"team_id": team.pk})
            return Response([{"name": event[0]} for event in events])
        elif key:
            result = get_property_values_for_key(key, team, value=request.GET.get("value"))
            for value in result:
                try:
                    # Try loading as json for dicts or arrays
                    flattened.append(json.loads(value[0]))
                except json.decoder.JSONDecodeError:
                    flattened.append(value[0])
        return Response([{"name": convert_property_value(value)} for value in flatten(flattened)])

    @action(methods=["GET"], detail=False)
    def sessions(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        filter = SessionsFilter(request=request)

        sessions, pagination = ClickhouseSessionsList.run(team=self.team, filter=filter)
        return Response({"result": sessions, "pagination": pagination})

    # ******************************************
    # /event/session_recording
    # params:
    # - session_recording_id: (string) id of the session recording
    # - save_view: (boolean) save view of the recording
    # ******************************************
    @action(methods=["GET"], detail=False)
    def session_recording(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        if not request.GET.get("session_recording_id"):
            return Response(
                {
                    "detail": "The query parameter session_recording_id is required for this endpoint.",
                    "type": "validation_error",
                    "code": "invalid",
                },
                status=400,
            )

        session_recording = SessionRecording().run(
            team=self.team, filter=Filter(request=request), session_recording_id=request.GET["session_recording_id"]
        )

        if request.GET.get("save_view"):
            SessionRecordingViewed.objects.get_or_create(
                team=self.team, user=request.user, session_id=request.GET["session_recording_id"]
            )

        return Response({"result": session_recording})
