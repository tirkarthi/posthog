# Generated by Django 3.1.8 on 2021-05-18 10:21

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("posthog", "0152_user_events_column_config"),
    ]

    operations = [
        migrations.AddField(model_name="plugin", name="capabilities", field=models.JSONField(default=dict),),
    ]
